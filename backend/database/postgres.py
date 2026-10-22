from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate

# Shared SQLAlchemy handle and migration helper; created here, attached to the app in create_app().
db = SQLAlchemy()
migrate = Migrate()
