import os
import sys
import json
import uuid
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from app.models import AddMediaRequest
from app.room_manager import room_manager

if getattr(sys, 'frozen', False):
    BASE_DIR = Path(sys._MEIPASS)
else:
    BASE_DIR = Path(__file__).resolve().parent.parent

STATIC_DIR = BASE_DIR / "static"

# Fallback: if static not found, search upward
if not STATIC_DIR.exists():
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "static"
        if candidate.exists():
            STATIC_DIR = candidate
            BASE_DIR = parent
            break

app = FastAPI(title="CyTube Magnet & Sync Video Room")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", response_class=FileResponse)
async def get_index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/r/{room_id}", response_class=FileResponse)
async def get_room_page(room_id: str):
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/rooms")
async def list_rooms():
    return {"rooms": room_manager.list_rooms()}


@app.get("/api/rooms/{room_id}/state")
async def get_room_state(room_id: str):
    room = room_manager.get_or_create_room(room_id)
    return room.get_full_state()


@app.post("/api/rooms/{room_id}/add")
async def add_media_api(room_id: str, req: AddMediaRequest):
    room = room_manager.get_or_create_room(room_id)
    item = await room.add_media_to_playlist(
        source=req.source,
        title=req.title,
        added_by=req.added_by or "Anonymous",
        play_now=False
    )
    return {"success": True, "item": item.model_dump()}


@app.websocket("/ws/{room_id}")
async def websocket_room_endpoint(websocket: WebSocket, room_id: str):
    await websocket.accept()
    room = room_manager.get_or_create_room(room_id)
    user_id = str(uuid.uuid4())[:8]
    username = f"User_{user_id[:4]}"

    try:
        # Register user with initial default name
        await room.add_user(user_id, username, websocket)

        while True:
            raw_data = await websocket.receive_text()
            try:
                payload = json.loads(raw_data)
            except Exception:
                continue

            event_type = payload.get("type")
            data = payload.get("data", {})

            if event_type == "set_username":
                new_name = str(data.get("username", "")).strip()[:24]
                if new_name and user_id in room.users:
                    old_name = room.users[user_id].username
                    room.users[user_id].username = new_name
                    username = new_name
                    await room.broadcast("user_renamed", {
                        "user_id": user_id,
                        "new_name": new_name,
                        "old_name": old_name
                    })
                    await room.add_chat_message(
                        user_id="system",
                        username="System",
                        text=f"✏️ {old_name} is now known as {new_name}",
                        is_system=True
                    )

            elif event_type == "chat":
                text = str(data.get("text", "")).strip()
                if text:
                    await room.add_chat_message(
                        user_id=user_id,
                        username=username,
                        text=text[:500]
                    )

            elif event_type == "playback":
                # Action: 'play' | 'pause' | 'seek'
                action = data.get("action")
                current_time = data.get("time", 0.0)

                state_map = {
                    "play": "playing",
                    "pause": "paused",
                    "seek": room.playback.state
                }
                new_state = state_map.get(action, room.playback.state)

                await room.update_playback(
                    state=new_state,
                    current_time=current_time,
                    sender_id=user_id
                )

            elif event_type == "playback_heartbeat":
                t = data.get("time", 0.0)
                await room.update_heartbeat(current_time=t, sender_id=user_id)

            elif event_type == "toggle_lock":
                locked = bool(data.get("locked", False))
                await room.set_lock_controls(locked=locked, sender_id=user_id)

            elif event_type == "add_media":
                source = str(data.get("source", "")).strip()
                title = data.get("title")
                play_now = bool(data.get("play_now", False))
                if source:
                    await room.add_media_to_playlist(
                        source=source,
                        title=title,
                        added_by=username,
                        play_now=play_now
                    )

            elif event_type == "skip":
                await room.skip_media(triggered_by=username)

            elif event_type == "play_item":
                item_id = data.get("item_id")
                if item_id:
                    await room.play_playlist_item(item_id, triggered_by=username)

            elif event_type == "vote_skip":
                await room.vote_skip(user_id=user_id)

            elif event_type == "remove_playlist_item":
                item_id = data.get("item_id")
                if item_id:
                    await room.remove_playlist_item(item_id, removed_by=username)

            elif event_type == "claim_leader":
                room.leader_id = user_id
                for uid, u in room.users.items():
                    u.is_leader = (uid == user_id)
                await room.broadcast("leader_changed", {
                    "leader_id": user_id,
                    "leader_name": username
                })
                await room.add_chat_message(
                    user_id="system",
                    username="System",
                    text=f"👑 {username} took control as the Room DJ!",
                    is_system=True
                )

    except WebSocketDisconnect:
        await room.remove_user(user_id)
    except Exception as e:
        await room.remove_user(user_id)
