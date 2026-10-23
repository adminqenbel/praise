import logging
import os

from flask import Flask, jsonify, request
from flask_cors import CORS
from sqlalchemy import text
from werkzeug.middleware.proxy_fix import ProxyFix

from config import DEV_SECRET_KEY, Config, production_problems
from database.postgres import db, migrate
from services.ratelimit import rate_limit


# Application factory: builds the Flask app, wires the databases and registers every route group.
# Tests call it with their own config so each test gets a clean app.
def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    security_log = logging.getLogger("praise.security")
    # In production an unsafe setting stops the start instead of serving families with it.
    if app.config.get("PRAISE_ENV") == "production":
        problems = production_problems(app.config)
        if problems:
            raise RuntimeError("Refusing to start in production: " + "; ".join(problems))
        if not app.config.get("GEMINI_API_KEY"):
            security_log.warning("GEMINI_API_KEY is empty: unknown sites will get each rule set's default")
    # Sessions are signed with SECRET_KEY, so running with the built-in dev value is unsafe outside tests: warn loudly.
    elif app.config["SECRET_KEY"] == DEV_SECRET_KEY and not app.config.get("TESTING"):
        security_log.warning("SECRET_KEY is the built-in dev value: set a random SECRET_KEY in backend/.env")

    # Behind a reverse proxy, take the client address and scheme from the headers it sets (and only that many hops).
    hops = app.config.get("TRUSTED_PROXY_HOPS", 0)
    if hops:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=hops, x_proto=hops)

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
    # PostgreSQL holds everything: accounts, rules, site intelligence, events and AI evidence.
    db.init_app(app)
    migrate.init_app(app, db)

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

    @app.cli.command("purge-events")
    def purge_events_cmd():
        """Delete events older than the retention period (90 days). Safe to run daily."""
        from services.event_service import RETENTION_DAYS, purge_older_than
        print(f"removed {purge_older_than()} event(s) older than {RETENTION_DAYS} days")

    # Liveness probe used by the launcher and the tests.
    @app.get("/health")
    def health():
        return jsonify(status="ok")

    # Same, plus one trivial query. For the keep-awake monitor (docs/DEPLOY.md): it keeps a free database from pausing for
    # inactivity and reports a database outage. Kept apart from /health so a database blip never makes the host restart us.
    @app.get("/health/ready")
    @rate_limit("ready", 60, 600)
    def ready():
        try:
            db.session.execute(text("SELECT 1"))
        except Exception:
            db.session.rollback()
            security_log.error("readiness check: database unreachable")
            return jsonify(status="degraded", database="down"), 503
        return jsonify(status="ok", database="ok")

    return app


if __name__ == "__main__":
    create_app().run(debug=os.environ.get("FLASK_DEBUG") == "1", port=5000)
