# NodeSync — SSH sync giữa CI runners

Runner khởi động sau chọn predecessor còn sống từ Firebase RTDB và đồng bộ các
path đã opt-in. NodeSync tái sử dụng Tailscale/cloudflared hiện hữu; không chạy
thêm tunnel daemon.

## Tự động hóa SSH

```dotenv
SSH_ENABLE=1
SSH_SYNC_PATHS=ci-data,uploads
SSH_1_USER=nodesync
SSH_1_PASS=<shared-secret>
```

CI chạy hoàn toàn non-interactive theo thứ tự:

1. `npm run ssh:env --prefix nodesync`: chuẩn hóa `.env`, tự sinh user/password
   khi thiếu, sinh Ed25519 key, gom và sắp xếp toàn bộ `SSH_*`, mask secrets;
2. `npm run ssh:smoke:prepare --prefix nodesync`: tạo smoke fixture khi bật;
3. `setup-users.mjs`: tạo mọi `SSH_<index>_USER`, password, home, `.ssh`,
   `authorized_keys`, private key và sudo `NOPASSWD`;
4. `setup-nodesync-ssh.mjs`: cài OpenSSH/rsync/sshpass, cấu hình sshd, host key,
   identity file và manifest RTDB;
5. discover predecessor, pin host key, verify remote node ID, rồi rsync.

Key authentication được thử trước; `SSH_<index>_PASS` là fallback qua
`sshpass -e`, nên password không nằm trong argv hay log. Không dùng
`StrictHostKeyChecking=accept-new`.

Các workflow tích hợp sẵn:

- `.github/workflows/test.yml`;
- `.azure/azure-pipelines.yml`.

## Transports

```dotenv
SSH_CHANNEL_TAILSCALE_ENABLE=1
SSH_CHANNEL_CLOUDFLARE_ENABLE=1
SSH_CHANNEL_HYBRID_ENABLE=1
```

Chế độ thường dùng fallback theo thứ tự Tailscale → Cloudflare → Hybrid để tránh
nhiều rsync ghi vào cùng destination. Mỗi endpoint vẫn phải khớp pinned host key
và remote node ID.

Cloudflare Access dùng tên chuẩn:

```dotenv
CF_SSH_TUNNEL_SERVICE_TOKEN_ID=<client-id>
CF_SSH_TUNNEL_SERVICE_TOKEN_SECRET=<client-secret>
```

`cloudflare/scripts/provision-tunnel.mjs` có thể tạo cặp này qua Cloudflare API.
Compose ánh xạ nội bộ sang tên biến mà `cloudflared access ssh` yêu cầu.

## Smoke sync

```dotenv
SSH_SYNC_SMOKE_ENABLE=1
```

Runner tạo `ci-runtime/smoke-sync-data` gồm file, cây thư mục, timestamp và
SHA-256 manifest. Các metadata sau được ghi vào env/RTDB:

- `ORCH_META_SSH_SMOKE_CREATED_AT`;
- `ORCH_META_SSH_SMOKE_CHECKSUM`;
- `ORCH_META_SSH_SMOKE_FILES`;
- `ORCH_META_SSH_SMOKE_DIRS`.

Runner kế tiếp chạy mọi channel đã bật song song. Mỗi channel ghi vào destination
riêng và lỗi độc lập:

- dữ liệu: `ci-runtime/smoke-sync-results/<channel>/`;
- report: `ci-runtime/nodesync/reports/<channel>.json`;
- tổng hợp: `ci-runtime/nodesync/reports/summary.json`.

Report có source/current node, auth mode, endpoint, start/end/duration, danh sách
file/thư mục, size, checksum từng file, checksum tổng và kết quả xác minh với
manifest nguồn. Task chỉ fail khi không channel nào thành công.

## Mặc định an toàn

```dotenv
SSH_ENABLE=0
SSH_SYNC_SMOKE_ENABLE=0
SSH_SYNC_PATHS=
```

Khi tắt hoặc path rỗng, NodeSync không discover, không SSH và không rsync.
