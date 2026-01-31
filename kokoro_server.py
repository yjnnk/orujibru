import io
import json
import wave
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

import numpy as np
from kokoro_onnx import Kokoro

HOST = "127.0.0.1"
PORT = 5178
BASE_DIR = Path(__file__).resolve().parent
LAST_STATE_FILE = BASE_DIR / "last-state.json"

_kokoro_cache: dict[tuple[str, str], Kokoro] = {}


def get_kokoro(model_path: str, voices_path: str) -> Kokoro:
  key = (model_path, voices_path)
  if key not in _kokoro_cache:
    _kokoro_cache[key] = Kokoro(model_path=model_path, voices_path=voices_path)
  return _kokoro_cache[key]


def audio_to_wav_bytes(audio: np.ndarray, sample_rate: int) -> bytes:
  audio = np.clip(audio, -1.0, 1.0)
  pcm16 = (audio * 32767).astype(np.int16)
  buffer = io.BytesIO()
  with wave.open(buffer, "wb") as wav_file:
    wav_file.setnchannels(1)
    wav_file.setsampwidth(2)
    wav_file.setframerate(sample_rate)
    wav_file.writeframes(pcm16.tobytes())
  return buffer.getvalue()


class Handler(SimpleHTTPRequestHandler):
  def __init__(self, *args, **kwargs):
    super().__init__(*args, directory=str(BASE_DIR), **kwargs)

  def end_headers(self):
    self.send_header("Cache-Control", "no-store")
    super().end_headers()

  def _send_text(self, status: int, message: str):
    encoded = message.encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "text/plain; charset=utf-8")
    self.send_header("Content-Length", str(len(encoded)))
    self.end_headers()
    self.wfile.write(encoded)

  def _send_json(self, status: int, payload: dict):
    encoded = json.dumps(payload).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Content-Length", str(len(encoded)))
    self.end_headers()
    self.wfile.write(encoded)

  def do_POST(self):
    if self.path not in ("/api/tts", "/api/voices", "/api/last-state"):
      self._send_text(404, "Not found")
      return

    length = int(self.headers.get("Content-Length", "0"))
    try:
      body = self.rfile.read(length).decode("utf-8")
      payload = json.loads(body or "{}")
    except Exception:
      self._send_text(400, "JSON invalido.")
      return

    if self.path == "/api/last-state":
      try:
        LAST_STATE_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
      except Exception:
        self._send_text(500, "Falha ao salvar estado.")
        return
      self._send_json(200, {"ok": True})
      return

    model_path = str(payload.get("modelPath", "")).strip()
    voices_path = str(payload.get("voicesPath", "")).strip()
    if not model_path or not voices_path:
      self._send_text(400, "Informe modelPath e voicesPath.")
      return

    try:
      kokoro = get_kokoro(model_path, voices_path)
    except Exception as error:
      self._send_text(500, str(error))
      return

    if self.path == "/api/voices":
      voices = kokoro.get_voices()
      default_voice = voices[0] if voices else ""
      self._send_json(200, {"voices": voices, "defaultVoice": default_voice})
      return

    text = str(payload.get("text", "")).strip()
    if not text:
      self._send_text(400, "Texto vazio.")
      return

    voice = str(payload.get("voice", "")).strip()
    if not voice:
      self._send_text(400, "Informe a voz.")
      return

    speed = payload.get("speed", 1.0)
    try:
      speed = float(speed)
    except Exception:
      speed = 1.0
    speed = max(0.5, min(2.0, speed))

    lang = str(payload.get("lang", "pt-br")).strip() or "pt-br"

    try:
      audio, sample_rate = kokoro.create(
        text=text,
        voice=voice,
        speed=speed,
        lang=lang,
      )
      wav_data = audio_to_wav_bytes(audio, sample_rate)
    except Exception as error:
      self._send_text(500, str(error))
      return

    self.send_response(200)
    self.send_header("Content-Type", "audio/wav")
    self.send_header("Content-Length", str(len(wav_data)))
    self.end_headers()
    self.wfile.write(wav_data)

  def do_GET(self):
    if self.path == "/api/last-state":
      if not LAST_STATE_FILE.exists():
        self._send_json(200, {})
        return
      try:
        data = json.loads(LAST_STATE_FILE.read_text(encoding="utf-8"))
      except Exception:
        self._send_json(200, {})
        return
      self._send_json(200, data if isinstance(data, dict) else {})
      return

    super().do_GET()


def main():
  server = HTTPServer((HOST, PORT), Handler)
  print(f"Servidor local em http://{HOST}:{PORT}")
  server.serve_forever()


if __name__ == "__main__":
  main()
