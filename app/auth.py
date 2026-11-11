import sqlite3
import hashlib
import secrets
from pathlib import Path
from typing import Optional, Dict

DB_PATH = Path(__file__).resolve().parent.parent / "users.db"

def init_db():
    conn = sqlite3.connect(str(DB_PATH))
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()

def hash_password(password: str, salt: Optional[str] = None) -> tuple[str, str]:
    if not salt:
        salt = secrets.token_hex(16)
    hashed = hashlib.sha256((salt + password).encode('utf-8')).hexdigest()
    return hashed, salt

def register_user(username: str, password: str) -> tuple[bool, str]:
    username = username.strip()
    if len(username) < 3 or len(username) > 20:
        return False, "El nombre de usuario debe tener entre 3 y 20 caracteres."
    if not username.isalnum() and "_" not in username:
        return False, "El usuario solo puede contener letras, números y guión bajo (_)."
    if len(password) < 4:
        return False, "La contraseña debe tener al menos 4 caracteres."

    hashed, salt = hash_password(password)

    conn = sqlite3.connect(str(DB_PATH))
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)", (username, hashed, salt))
        conn.commit()
        return True, "Usuario registrado con éxito."
    except sqlite3.IntegrityError:
        return False, "El nombre de usuario ya está en uso."
    except Exception as e:
        return False, f"Error en base de datos: {str(e)}"
    finally:
        conn.close()

def authenticate_user(username: str, password: str) -> tuple[bool, str]:
    username = username.strip()
    conn = sqlite3.connect(str(DB_PATH))
    cursor = conn.cursor()
    cursor.execute("SELECT password_hash, salt, username FROM users WHERE username = ?", (username,))
    row = cursor.fetchone()
    conn.close()

    if not row:
        return False, "Usuario no encontrado."

    expected_hash, salt, canonical_name = row
    test_hash, _ = hash_password(password, salt)
    if test_hash == expected_hash:
        return True, canonical_name
    return False, "Contraseña incorrecta."

# Auto-initialize DB on import
init_db()
