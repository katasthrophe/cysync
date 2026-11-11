from typing import Optional, List, Literal
from pydantic import BaseModel, Field
import time
import uuid

class MediaItem(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    type: Literal["youtube", "torrent", "url", "tiktok", "twitter"]
    source: str
    title: str = "Untitled Media"
    duration: float = 0.0
    thumbnail: Optional[str] = None
    added_by: str = "Anonymous"
    added_at: float = Field(default_factory=time.time)

class PlaybackState(BaseModel):
    state: Literal["playing", "paused", "buffering"] = "paused"
    current_time: float = 0.0
    last_update: float = Field(default_factory=time.time)
    playback_rate: float = 1.0

    def get_synced_time(self) -> float:
        """Returns projected playback time based on elapsed wall time if playing."""
        if self.state == "playing":
            elapsed = time.time() - self.last_update
            return max(0.0, self.current_time + (elapsed * self.playback_rate))
        return self.current_time

class ChatMessage(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    user_id: str
    username: str
    text: str
    timestamp: float = Field(default_factory=time.time)
    is_system: bool = False
    badge: Optional[str] = None

class UserInfo(BaseModel):
    user_id: str
    username: str
    is_leader: bool = False
    joined_at: float = Field(default_factory=time.time)

class AddMediaRequest(BaseModel):
    source: str
    title: Optional[str] = None
    added_by: Optional[str] = "Anonymous"
