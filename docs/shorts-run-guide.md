# Hướng dẫn chạy Flow Shorts Factory

Hướng dẫn này chạy bản CLI trong repository. Tool tạo kế hoạch bằng Gemini, sau đó tạo ảnh mở đầu, lời thoại WAV và clip Google Flow cho từng cảnh.

## 1. Chuẩn bị

- Node.js 20 trở lên.
- Google Chrome.
- Gemini API key có quyền gọi các model đã chọn.
- Tài khoản Google có quyền sử dụng Flow và đủ quota/credits.

Tại thư mục repository, cài dependencies:

```bash
npm ci
```

Không cần build riêng khi chạy bằng `npm run dev`. Nếu muốn chạy bản build:

```bash
npm run build
node dist/src/index.js --help
```

## 2. Cung cấp Gemini API key

Trong terminal zsh/bash hiện tại, nhập key mà không hiện ký tự trên màn hình:

```bash
printf 'Gemini API key: '
read -s GEMINI_API_KEY
printf '\n'
export GEMINI_API_KEY
```

Key chỉ có hiệu lực trong terminal này. Không ghi key trực tiếp vào lệnh, README, `project.json`, `creative-plan.json` hoặc Git. Khi mở terminal mới, nhập lại key.

## 3. Tạo kế hoạch 10 tập

```bash
npm run dev -- shorts plan \
  --topic "Đại dương kỳ bí" \
  --out ./shorts-output/ocean
```

Tool tạo:

- `shorts-output/ocean/project.json`
- `shorts-output/ocean/creative-plan.json`

Kế hoạch gồm 10 tập, mỗi tập 10 cảnh, mỗi cảnh 8 giây. Có thể đổi ngôn ngữ hoặc model bằng `--language`, `--text-model`, `--image-model`, `--tts-model`; model phải được Gemini hỗ trợ và key của bạn phải có quyền truy cập.

## 4. Đăng nhập Google Flow

Mở một profile riêng có tên `shorts`:

```bash
npm run dev -- auth login --profile shorts
```

Đăng nhập Google thủ công trong Chrome vừa mở và hoàn tất mọi bước xác minh. Không nhập thông tin tài khoản vào terminal hoặc file cấu hình của tool.

## 5. Tạo 100 clip

```bash
npm run dev -- shorts generate \
  ./shorts-output/ocean/project.json \
  --profile shorts
```

Lệnh này gọi Gemini để tạo 100 ảnh và 100 đoạn lời thoại, rồi chạy Google Flow tuần tự để tạo 100 clip 8 giây. Đây là thao tác có thể tiêu tốn đáng kể quota/credits; hãy kiểm tra tài khoản trước khi chạy. Hiện chưa có chế độ dry-run cho bước tạo này.

Các file được lưu theo cảnh, ví dụ:

```text
shorts-output/ocean/
├── generation.json
├── episodes/
│   └── 01/scenes/01/
│       ├── start.jpg     # có thể là start.png
│       ├── narration.wav
│       └── clip.mp4
└── flow-output/          # file trung gian do Flow tải về
```

`generation.json` lưu trạng thái và checksum để có thể xác minh artifact khi tiếp tục. Đừng sửa file journal hoặc đổi nội dung kế hoạch giữa chừng.

## 6. Tiếp tục sau khi dừng

Nếu mất kết nối, đóng terminal hoặc Flow yêu cầu đăng nhập/xác minh/quota, tool sẽ ghi `action-required.json` nếu đó là lỗi cần thao tác thủ công. Giải quyết nguyên nhân trước. Nếu cần đổi tài khoản, hãy chuyển tài khoản thủ công trong Chrome profile `shorts`; tool không tự luân chuyển tài khoản.

Sau đó chạy lại:

```bash
npm run dev -- shorts generate \
  ./shorts-output/ocean/project.json \
  --profile shorts \
  --resume
```

Không dùng `--resume` cho lần chạy đầu. Nếu đã có `generation.json`, CLI yêu cầu `--resume`. Artifact đã lưu chỉ được bỏ qua khi kích thước, checksum và định dạng vẫn hợp lệ.

## 7. Các giới hạn hiện tại

- Đầu ra hiện là 100 clip riêng lẻ, mỗi clip 8 giây; chưa ghép thành 10 video hoàn chỉnh khoảng 80 giây.
- Chưa tự render bằng FFmpeg và chưa đăng TikTok/YouTube.
- Đăng nhập, CAPTCHA, xác minh, đổi tài khoản và xử lý quota đều do người dùng thao tác thủ công.
- Automation điều khiển giao diện Google Flow nên có thể cần cập nhật nếu giao diện Flow thay đổi.
- Kiểm thử tự động dùng adapter giả; lần đầu chạy thật có thể cần xử lý khác biệt về tài khoản, model hoặc giao diện.

## 8. Trợ giúp CLI

```bash
npm run dev -- shorts --help
npm run dev -- shorts plan --help
npm run dev -- shorts generate --help
```
