import uvicorn
import sys

if __name__ == "__main__":
    port = 8000
    host = "0.0.0.0"
    print(f"🚀 Starting CySync (Cytube Clone with YouTube & Torrent Magnet Sync)...")
    print(f"📡 Access locally at: http://localhost:{port}")
    print(f"🌐 Access room example: http://localhost:{port}/r/cinema")
    uvicorn.run("app.main:app", host=host, port=port, reload=True, ws="auto")
