"""
dependencies.py — JWT creation/validation + role guards.
Role hierarchy: overlord > manager > admin > standard
"""
import os
import jwt
from datetime import datetime, timedelta, timezone
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

SECRET_KEY = os.environ.get("DATAAPP_SECRET", "changeme-super-secret-key-2024")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 480  # 8-hour sessions

bearer_scheme = HTTPBearer()


def create_access_token(data: dict) -> str:
    payload = data.copy()
    payload["exp"] = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired. Please log in again.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token.")


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
    return decode_token(credentials.credentials)


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    """Allow 'admin', 'manager', and 'overlord' roles (overlord ⊇ manager ⊇ admin)."""
    if user.get("role") not in ("admin", "manager", "overlord"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required.",
        )
    return user


def require_manager(user: dict = Depends(get_current_user)) -> dict:
    """Allow 'manager' and 'overlord' roles only."""
    if user.get("role") not in ("manager", "overlord"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Manager access required.",
        )
    return user


def require_overlord(user: dict = Depends(get_current_user)) -> dict:
    """Allow only the 'overlord' role."""
    if user.get("role") != "overlord":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Overlord access required.",
        )
    return user


def require_approved(user: dict = Depends(get_current_user)) -> dict:
    if not user.get("is_approved"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your account is pending admin approval.",
        )
    return user
