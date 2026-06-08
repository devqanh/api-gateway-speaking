# Luyện giao tiếp AI

Ứng dụng luyện nói realtime qua mic với OpenAI Realtime API và model `gpt-realtime-2`.

## Chạy local

1. Tạo file `.env.local` từ `.env.example`.
2. Điền key mới:

```bash
OPENAI_API_KEY=your_new_openai_api_key
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_TRANSCRIPTION_MODEL=gpt-realtime-whisper
OPENAI_TTS_MODEL=gpt-4o-mini-tts
PORT=3000
HOST=127.0.0.1
```

3. Chạy app khi phát triển:

```bash
npm run dev
```

Lệnh này dùng `nodemon`, tự restart server khi bạn sửa `server.js` hoặc file trong `public/`.

Hoặc chạy bản thường:

```bash
npm start
```

4. Mở `http://localhost:3000`.

## Ghi chú bảo mật

Không đưa OpenAI API key vào trình duyệt. App này giữ key ở `server.js`; browser chỉ xin Realtime token tạm thời từ server rồi dùng token đó để bắt tay WebRTC với OpenAI.

Nếu bạn đã dán key vào chat, hãy thu hồi key đó trong OpenAI dashboard và tạo key mới trước khi chạy app.
# api-gateway-speaking
