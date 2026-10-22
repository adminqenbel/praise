import logging
import os

from flask import Flask, jsonify, request
from flask_cors import CORS

from config import Config
from database.postgres import db, migrate
from database.mongo import init_mongo


# Application factory: builds the Flask app, wires the databases and registers every route group.
# Tests call it with their own config so each test gets a clean app.
def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # Sessions are signed with SECRET_KEY, so running with the built-in dev value is unsafe outside tests: warn loudly.
    if app.config["SECRET_KEY"] == "dev-only-change-me" and not app.config.get("TESTING"):
        logging.getLogger("praise.security").warning(
            "SECRET_KEY is the built-in dev value: set a random SECRET_KEY in backend/.env")

    # Safety headers on every response: no content sniffing, no referrer leaks, no framing (clickjacking).
    @app.after_request
    def security_headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"    # responses hold private family data
        return resp

    # Only the dashboard's origin may call the API from a browser, and only it may send the session cookie.
    CORS(app, supports_credentials=True, origins=[app.config["DASHBOARD_ORIGIN"]])
    # PostgreSQL (system of record) and MongoDB (events and AI evidence) are attached here.
    db.init_app(app)
    migrate.init_app(app, db)
    init_mongo(app)

    from database import models  # noqa: F401  (register tables for migrations)

    # Route groups: auth (sign-up, login, pairing, chat), child (extension API), policy (parent dashboard API), admin (review queue).
    from routes.auth import bp as auth_bp
    app.register_blueprint(auth_bp)
    from routes.child import bp as child_bp
    from routes.policy import bp as policy_bp
    from routes.admin import bp as admin_bp
    app.register_blueprint(child_bp)
    app.register_blueprint(policy_bp)
    app.register_blueprint(admin_bp)

    # Command-line helpers, run as `flask --app app <name>`.
    @app.cli.command("create-admin")
    def create_admin():
        """Create an admin user (prompts for email/password)."""
        import click
        from database.models import User
        from services.auth_service import hash_password
        email = click.prompt("Admin email").strip().lower()
        pw = click.prompt("Password", hide_input=True, confirmation_prompt=True)
        db.session.add(User(email=email, password_hash=hash_password(pw), role="admin"))
        db.session.commit()
        click.echo("admin created")

    @app.cli.command("purge-demo")
    def purge_demo_cmd():
        """Delete the demo accounts (anything @demo.test) and everything they own."""
        from database.models import User
        users = User.query.filter(User.email.like("%@demo.test")).all()
        for u in users:
            db.session.delete(u)
        db.session.commit()
        print(f"removed {len(users)} demo account(s)")

    @app.cli.command("seed-sites")
    def seed_sites_cmd():
        """Load the well-known-sites list (safe to repeat; never overwrites existing rows)."""
        from services.seed_sites import seed_sites
        added, present = seed_sites()
        print(f"seeded {added} sites ({present} left as they were)")

    @app.cli.command("init-mongo")
    def init_mongo_cmd():
        """Create MongoDB indexes (idempotent)."""
        from database.mongo import ensure_indexes
        ensure_indexes()
        print("mongo indexes ready")

    # Liveness probe used by the launcher and the tests.
    @app.get("/health")
    def health():
        return jsonify(status="ok")

    return app


if __name__ == "__main__":
    create_app().run(debug=os.environ.get("FLASK_DEBUG") == "1", port=5000)
