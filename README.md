# WebTerm

Terminal SSH lấy cảm hứng từ MobaXterm. Có quản lý session, terminal nhiều tab, chia màn hình, SFTP, SSH tunnel, jump host, terminal local (PowerShell/CMD/Git Bash), RDP, macro, MultiExec, giám sát server, tạo SSH key và master password.

Dùng được theo 2 cách: **app desktop Windows** (`.exe`) hoặc **web** chạy bằng `npm start`.

## Sửa lỗi 1.2.1

- **RDP vừa cửa sổ hơn**: bật co giãn nội dung và cập nhật độ phân giải khi thay đổi kích thước cửa sổ Remote Desktop. Áp dụng cả session RDP đã lưu; tuỳ chọn toàn màn hình vẫn được giữ. Kích thước ban đầu do Windows chọn theo màn hình hiện tại.

Thiết lập dùng `smart sizing` và `dynamic resolution` theo [tài liệu Microsoft](https://learn.microsoft.com/en-us/azure/virtual-desktop/rdp-properties#display-settings). Khả năng cập nhật độ phân giải phụ thuộc máy RDP; co giãn nội dung giúp giữ desktop nằm trong cửa sổ.

## Nâng cấp 1.2.0

- **Mở lại tab vừa đóng**: nút **+** → **Mở lại tab vừa đóng**, menu **Công cụ**, hoặc **Ctrl+Shift+T** trong app desktop. Bảng **Ctrl+K** cũng liệt kê tối đa 10 tab vừa đóng. Mở lại tạo kết nối mới và giữ tên tab, dùng cấu hình session hiện tại. Lịch sử chỉ nằm trong bộ nhớ, không chứa mật khẩu, OTP hay nội dung terminal, và mất khi tắt app.
- **Dùng bàn phím thuận tiện hơn**: trên thanh tab, dùng ←/→, Home/End, Enter/Space. Các menu hỗ trợ ↑/↓, Home/End, Enter/Space và Esc, bỏ qua mục bị vô hiệu và trả focus về nút mở menu. Đóng tab sẽ chọn tab liền kề; kết nối hoàn tất không giành focus khi đang nhập ở nơi khác.
- **Editor giữ đúng thay đổi**: nội dung gõ thêm trong lúc lưu vẫn hiện “Chưa lưu”; Ctrl+S liên tiếp không ghi song song. Đóng/thay file sẽ đợi lưu xong và hỏi trước khi bỏ thay đổi. Đóng app sẽ cảnh báo cả khi chỉ còn file chưa lưu. Nếu kết nối bị thay thế, bản nháp được giữ để sao chép, không ghi sang kết nối mới.
- **Duyệt SFTP ổn định khi mạng chậm**: chỉ kết quả của yêu cầu mới nhất được cập nhật thư mục và danh sách file; bỏ phản hồi cũ sau reconnect. Nút Home, làm mới và chế độ theo terminal không ghi đè thao tác mới bằng kết quả đến muộn.
- **Khôi phục backup an toàn hơn**: kiểm tra cấu trúc, session, macro, tunnel và jump host trước khi thay dữ liệu. Chế độ thay thế từ chối backup có mục lỗi; lỗi ghi file sẽ phục hồi các file đã chạm tới. Nếu phục hồi bị chặn, thông báo chỉ rõ bản sao còn giữ lại. Tunnel đang chạy chỉ dừng sau khi dữ liệu mới đã lưu thành công.
- **Tunnel không để lại cổng mở** nếu bị dừng/xoá trong lúc đang khởi động; callback và lần kết nối lại cũ không ảnh hưởng lần chạy mới.

Khôi phục backup có phục hồi khi thao tác ghi báo lỗi, nhưng không phải giao dịch nguyên tử qua nhiều file khi máy tắt đột ngột. Nếu tiến trình bị tắt giữa chừng, các bản `.restore-*.bak` còn trong thư mục dữ liệu là bản sao trước khi khôi phục.

## Nâng cấp 1.1.0

- **Truy cập nhanh (`Ctrl+K`)**: tìm session, chuyển tab đang mở, mở terminal local, cài đặt, tunnel, sao lưu và các công cụ. Tìm không dấu theo tên, host, username, thư mục hoặc ghi chú; dùng ↑/↓, Enter và Esc để điều khiển. Có nút kính lúp ở góc trên bên phải. Bảng này không chen vào khi đang nhập mật khẩu hoặc xác nhận host key.
- **Kết nối ổn định hơn**: kết nối lại hoặc đóng tab sẽ huỷ yêu cầu mật khẩu, host key và OTP của lần kết nối cũ. Nhấn R liên tiếp không tạo thêm yêu cầu đăng nhập; dùng Enter trên nút của session chỉ thực hiện đúng thao tác được chọn.
- **Lưu file SFTP an toàn hơn**: editor tích hợp và editor ngoài ghi vào file tạm, giữ quyền file rồi mới thay bản cũ. Nếu SFTP cũ không hỗ trợ thay file nguyên tử, WebTerm giữ bản dự phòng để phục hồi khi thay thế thất bại; nếu phục hồi cũng lỗi, thông báo chỉ rõ đường dẫn bản gốc. Không xoá bản cũ trước khi có bản mới. Chặn thêm các đường dẫn tương đương thư mục gốc khi xoá.
- **Server bền hơn với dữ liệu lỗi**: cookie sai định dạng, frame WebSocket JSON không hợp lệ và kích thước terminal không hợp lệ không làm dừng server.
- **Tương thích Windows PowerShell**: RDP/DPAPI hoạt động cả khi khởi chạy từ PowerShell 7 có đường dẫn module khác phiên bản.

SSH server hỗ trợ OpenSSH rename sẽ thay file nguyên tử. Với SFTP cũ phải đổi tên hai lần, file đích có thể tạm vắng trong khoảng rất ngắn; nếu kết nối mất ở giữa, bản gốc vẫn nằm ở file `.wtbak-*` cùng thư mục.

Lưu qua file tạm giữ quyền Unix và đi theo symlink, nhưng tạo inode mới: owner có thể đổi sang tài khoản SSH, ACL/xattr và liên kết hardlink không được giữ lại.

## App desktop (Windows)

File cài đặt nằm trong thư mục `dist/` sau khi build:

| File | Dùng khi |
| --- | --- |
| `WebTerm-Setup-1.2.1.exe` | Cài vào máy, có shortcut ở Desktop và Start Menu, gỡ được trong Settings → Apps |
| `WebTerm-Portable-1.2.1.exe` | Chạy luôn không cần cài. Chép vào USB là mang theo được cả session (xem [Chạy từ USB](#chạy-từ-usb)) |

File chưa được ký số, nên lần đầu mở Windows SmartScreen có thể báo "Windows protected your PC". Bấm **More info → Run anyway**.

Khác biệt so với bản web:

- Không cần cài Node, không cần mở trình duyệt hay nhớ link token. Server nội bộ chạy ngay trong app và chỉ nghe `127.0.0.1`.
- **Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+R** đi thẳng vào terminal (trong trình duyệt các phím này đóng/mở tab). Bấm **F11** để toàn màn hình.
- Còn phiên đang mở thì đóng cửa sổ sẽ có hộp thoại hỏi lại.
- Bản cài đặt lưu dữ liệu ở `%APPDATA%\WebTerm\data`, riêng với thư mục `data/` của bản web. Bản Portable lưu cạnh file `.exe` (xem dưới).

### Chạy từ USB

Bản Portable lưu mọi thứ vào thư mục `WebTerm-data` nằm ngay cạnh file `.exe`, giống MobaXterm Portable:

```
E:\
├─ WebTerm-Portable-1.2.1.exe
└─ WebTerm-data\
   ├─ data\      session, mật khẩu đã lưu (mã hoá), macro, tunnel, cài đặt, known hosts
   ├─ keys\      SSH key tạo bằng Công cụ → Tạo SSH key
   └─ browser\   dữ liệu của cửa sổ app (cache, session gần đây)
```

- Cắm USB sang máy Windows 10/11 64-bit khác và mở file `.exe`: session, mật khẩu, cài đặt đi theo. Máy đó không cần cài gì, và gần như không giữ lại dữ liệu nào sau khi tắt app.
- Trên thanh trên cùng có nhãn **USB**; trang chủ cho biết dữ liệu đang nằm ở đâu.
- Lần đầu chạy trên máy đã dùng WebTerm, app hỏi có **chép session của máy này sang USB** không.
- **SSH key:** session chỉ cần ghi tên file (vd. `id_ed25519`), WebTerm tự tìm trong `WebTerm-data\keys`. Nhờ vậy USB mang ký tự ổ nào (E:, F:…) cũng chạy. Key có sẵn thì chép vào thư mục `keys` rồi sửa session thành tên file. Đường dẫn đầy đủ vẫn dùng được.
- **Nên bật master password** (Cài đặt → Bảo mật). Nếu không, ai cầm USB cũng dùng được mật khẩu đã lưu.
- USB bị khoá ghi thì app báo, và lần đó lưu dữ liệu trên máy như bản cài đặt.
- Mỗi lần mở, file `.exe` (khoảng 120 MB) phải giải nén ra thư mục tạm, nên USB chậm sẽ khởi động lâu hơn.

Tự build lại:

```bash
npm install
```

```bash
npm run dist
```

Chạy thử không cần đóng gói: `npm run app`.

## Giao diện

- **Thanh trên cùng:** các nút chính (Session, Terminal, Chia, MultiExec, Tunnel, Công cụ), ô **Kết nối nhanh** (`user@host:port`), nút đổi sáng/tối và nút Cài đặt. Trong app desktop, thanh này cũng là thanh tiêu đề: kéo để di chuyển cửa sổ, double-click để phóng to.
- **Thanh dọc bên trái:** chuyển giữa **Sessions**, **SFTP** và **Macros**. Bấm lại mục đang mở để thu gọn thanh bên.
- **Trang chủ:** lối tắt tạo session, mở terminal local, quản lý tunnel, import MobaXterm; danh sách session mở gần đây và vài mẹo dùng nhanh.
- **Tab:** chấm màu cho biết trạng thái kết nối. Nút **+** cạnh các tab mở nhanh session mới, terminal local hoặc kết nối nhanh.
- **Truy cập nhanh:** bấm **Ctrl+K** hoặc nút kính lúp ở góc phải để tìm session, chuyển tab và mở công cụ bằng bàn phím. Hỗ trợ tìm không dấu và nhiều từ cùng lúc.
- **Tab vừa đóng:** bấm **+ → Mở lại tab vừa đóng**; app desktop hỗ trợ **Ctrl+Shift+T**. Chọn từng tab trong bảng **Ctrl+K**. Mở lại sẽ tạo phiên mới, không phục hồi tiến trình của shell cũ.
- **Sáng / tối:** mặc định theo Windows. Bấm nút mặt trời/mặt trăng để đổi nhanh, hoặc chọn cố định trong **Cài đặt → Giao diện**. Bảng màu của terminal chọn riêng (có cả bảng màu sáng như One Light, Solarized Light).
- **Cửa sổ hẹp:** chữ trên các nút tự ẩn chỉ còn biểu tượng; thanh bên nổi lên trên terminal; chia dọc đổi thành xếp hàng; thanh trạng thái ẩn bớt thông số ít quan trọng.

## Tính năng (so với MobaXterm)

### Kết nối

| MobaXterm | WebTerm |
| --- | --- |
| Session manager | Thanh **Sessions**: thư mục lồng nhau, tìm theo tên/host/user/ghi chú, màu riêng, menu chuột phải. Có 3 kiểu session: **SSH**, **RDP**, **Terminal local** |
| Terminal local (Cygwin) | Nút **Terminal** (hoặc **+** cạnh các tab): PowerShell, PowerShell 7, CMD, Git Bash, WSL (nếu có) chạy ngay trong tab |
| RDP session | Session kiểu RDP: double-click là mở Remote Desktop (mstsc), tự đăng nhập bằng mật khẩu đã lưu |
| SSH gateway (jump host) | Trong form session chọn **Jump host**: đi qua một server trung gian (tối đa 3 tầng), host key được hỏi riêng cho từng tầng |
| MobaSSHTunnel | Nút **Tunnel** (số trên nút là số tunnel đang chạy): tunnel Local (-L), Remote (-R), Dynamic SOCKS5 (-D); chạy/dừng từng cái, tự chạy khi mở app, tự nối lại khi rớt mạng |
| Execute command | Mỗi session SSH có ô **Lệnh chạy sau khi đăng nhập** và ô **Ghi chú** |
| Xác thực 2 bước | Server hỏi mã OTP thì WebTerm hiện hộp thoại nhập mã (mật khẩu vẫn tự điền) |

### Terminal

| MobaXterm | WebTerm |
| --- | --- |
| Nhiều tab | Bấm **R** để kết nối lại khi phiên bị ngắt; Ctrl + lăn chuột để đổi cỡ chữ |
| Find | **Ctrl+F**: tìm trong terminal, tô mọi kết quả, Enter / Shift+Enter để nhảy tới kết quả sau / trước; có tuỳ chọn phân biệt hoa thường, nguyên từ, regex. Trong vim, htop, nano… Ctrl+F vẫn gửi cho chương trình; khi đó dùng **Ctrl+Shift+F** |
| Split | Nút **Chia**: 1 màn hình / 2 cột / 2 hàng / 4 ô |
| MultiExec | Nút **MultiExec**: mọi tab hiện dạng lưới, gõ một lần là chạy trên mọi tab có tick |
| Macros | Mục **Macros** ở thanh bên: lưu danh sách lệnh, hoặc bấm nút ghi (chấm đỏ) để ghi lại phím gõ; chạy trên tab hiện tại hoặc mọi tab MultiExec |
| Syntax highlighting | Tự tô màu error/failed (đỏ), warning (vàng), success/OK/active (xanh lá), địa chỉ IP (xanh dương). Không tô đè màu của chương trình (ls --color) và không lem màu sang vim/htop |
| Settings | Nút **Cài đặt** (góc phải): giao diện sáng/tối, 7 bảng màu (WebTerm, MobaXterm cổ điển, Solarized, Dracula, Monokai, One Light…), font, cỡ chữ, kiểu con trỏ, số dòng lưu lại, bật/tắt copy khi bôi đen, chuột phải để dán, tô màu từ khoá |
| Remote monitoring | Thanh trạng thái: CPU, RAM, disk `/`, tốc độ mạng, load, uptime (server Linux) |

### SFTP

| MobaXterm | WebTerm |
| --- | --- |
| Sidebar SFTP | Panel **SFTP** tự mở theo tab SSH đang chọn |
| Follow terminal folder | Bật nút **ghim** trên panel SFTP: panel tự đi theo thư mục hiện tại của terminal (Linux + OpenSSH/Dropbear) |
| Chọn nhiều file | Ctrl/Shift + click, Ctrl+A, phím Delete/F2/Enter/Backspace; chuột phải để xoá, chmod, tải về hàng loạt |
| Upload/Download thư mục | Kéo thả cả thư mục để upload (hoặc nút **Upload cả thư mục**). Tải thư mục hoặc nhiều mục về dạng **.zip** (hỗ trợ file > 4 GB) |
| Hàng đợi truyền file | Upload chạy 2 file song song, có tiến trình, tốc độ, nút huỷ. Upload ghi vào file tạm rồi mới thay file cũ, nên huỷ giữa chừng không làm hỏng file trên server |
| MobaTextEditor | Double-click file text (≤ 2 MB) để sửa ngay trong app (Ctrl+S) |
| Open with external editor | Chuột phải file → **Sửa bằng app ngoài**: mở bằng VS Code/Notepad++/Notepad, mỗi lần lưu tự upload lại; nếu file trên server bị người khác sửa thì hỏi trước khi ghi đè |

### Bảo mật và tiện ích

| MobaXterm | WebTerm |
| --- | --- |
| MobaKeyGen | **Công cụ → Tạo SSH key**: Ed25519 hoặc RSA 4096, có passphrase, lưu vào `~/.ssh` (chạy từ USB thì vào `WebTerm-data\keys`); nút **Chép lên server** (giống `ssh-copy-id`) và **Dùng cho session** |
| Master password | **Cài đặt → Bảo mật**: khoá mọi mật khẩu đã lưu bằng master password, phải nhập khi mở app (có nút Bỏ qua). Nút ổ khoá trên thanh trên cùng để khoá ngay |
| Export/Import | **Công cụ → Sao lưu / Khôi phục**: session, macro, tunnel, cài đặt, known hosts ra file JSON; có thể kèm mật khẩu đã lưu (mã hoá bằng mật khẩu backup). **Import session từ MobaXterm.ini** cũng nằm ở đây |
| Cảnh báo host key | Hỏi fingerprint ở lần đầu kết nối, cảnh báo đỏ khi host key thay đổi |

## Chạy dạng web

Cần Node.js 20 trở lên (máy hiện có Node 24).

```bash
npm install
```

```bash
npm start
```

Server in ra một link dạng `http://127.0.0.1:3366/?token=...` và tự mở trình duyệt. Mở link một lần là trình duyệt nhớ (cookie). Không muốn tự mở trình duyệt thì dùng `npm run serve`.

### Biến môi trường

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PORT` | `3366` | Cổng web |
| `HOST` | `127.0.0.1` | Địa chỉ lắng nghe. Chỉ đổi sang `0.0.0.0` khi đã đặt sau HTTPS (nginx/Caddy) |
| `WEBTERM_TOKEN` | tự sinh | Token truy cập cố định |
| `WEBTERM_DATA` | `./data` | Thư mục lưu session, known hosts, khoá mã hoá, macro, tunnel, cài đặt |
| `WEBTERM_LOCAL` | `1` | Đặt `0` để tắt hẳn terminal local, RDP, editor ngoài và lưu key vào `~/.ssh` |

## Dùng session từ MobaXterm

1. **Công cụ → Import session từ MobaXterm** (hoặc **Import MobaXterm** ở trang chủ). WebTerm tìm `%APPDATA%\MobaXterm\MobaXterm.ini` (hoặc `Documents\MobaXterm`, thư mục cài đặt).
2. Xem danh sách rồi bấm **Import**. Session trùng (cùng tên, host, port, user) được bỏ qua.
3. Mật khẩu **không** được import vì MobaXterm mã hoá bằng master password của nó. Lần đầu kết nối, WebTerm hỏi username và mật khẩu, kèm tuỳ chọn lưu lại.

## Bảo mật

- Mặc định chỉ nghe trên `127.0.0.1`. Mọi API và WebSocket cần cookie token (`HttpOnly`, `SameSite=Strict`), kiểm tra `Origin` và `Host` để trang web lạ không gọi được và chặn DNS rebinding.
- **Tính năng chạm vào máy local** (terminal local, RDP, editor ngoài, lưu key vào `~/.ssh`) chỉ chạy khi request đi thẳng từ chính máy này. Đi qua reverse proxy (có header `X-Forwarded-For`/`Forwarded`/`X-Real-IP`) hoặc đặt `WEBTERM_LOCAL=0` là bị chặn.
- Mật khẩu/passphrase được mã hoá AES-256-GCM và không bao giờ gửi ngược về trình duyệt.
  - Không bật master password: khoá nằm ở `data/secret.key`, nên ai có cả thư mục dữ liệu thì giải mã được. Đừng chia sẻ thư mục này.
  - Bật master password: khoá được bọc bằng scrypt + AES-GCM trong `data/vault.json`, và khoá dữ liệu được đổi mới ngay lúc bật (bản `secret.key` cũ không còn dùng được). Nhập sai thì phải chờ lâu dần.
  - Quên master password thì không khôi phục được mật khẩu đã lưu (session vẫn còn).
- Tunnel chỉ kết nối tới server đã được tin tưởng host key. Server mới thì bấm **Tin tưởng…** trong bảng tunnel.
- RDP tự đăng nhập bằng file `.rdp` tạm, trong đó mật khẩu được mã hoá DPAPI (chỉ user Windows hiện tại giải mã được). File bị xoá sau khoảng 20 giây. Mật khẩu không bao giờ nằm trên dòng lệnh.
- Nếu mở ra ngoài (`HOST=0.0.0.0`), bắt buộc đặt sau HTTPS và giữ kín token.

## Giới hạn đã biết

- **SFTP theo terminal**: cần server Linux có `/proc` và OpenSSH hoặc Dropbear. Sau `sudo -i` khi đăng nhập bằng user thường, hoặc trong tmux/screen, panel dừng ở thư mục cuối cùng đọc được. Shell tự báo thư mục (OSC 7) thì luôn theo được.
- **RDP tự đăng nhập**: một số chính sách Windows bắt mstsc luôn hỏi mật khẩu. Khi đó đổi session sang "Lưu vào Windows Credential Manager" hoặc "Để Windows hỏi".
- Chưa có: X11 forwarding, VNC, cổng Serial/Telnet.

## Test

```bash
npm test
```

Chạy unit test và 6 nhóm test end-to-end với SSH server giả (`test/fake-sshd.js`). Nội dung kiểm tra:

- bảo mật (token, Origin, Host, chặn tính năng local qua proxy);
- session, cài đặt, macro;
- jump host, OTP, tunnel -L/-R/-D (kể cả tự nối lại);
- upload an toàn, zip (kiểm bằng `tar.exe` và `Expand-Archive`, có ZIP64), SFTP theo terminal, editor ngoài;
- terminal local, RDP (chế độ dry-run), tạo key và đăng nhập bằng key;
- master password, sao lưu/khôi phục.
- hồi quy cookie/WebSocket sai định dạng, lưu SFTP thất bại và phục hồi bản cũ, huỷ hộp thoại và kết nối terminal cũ, tìm kiếm không dấu, module Windows PowerShell.
- editor đang lưu, điều hướng SFTP có phản hồi đến muộn, lịch sử tab không giữ bí mật, khôi phục backup bị lỗi và tunnel bị dừng khi khởi động.

Chỉ chạy một nhóm: `npm test -- sftp`.

Kiểm tra app desktop: `npm run test:app` (bản dev) hoặc `node test/app-smoke.js dist\win-unpacked\WebTerm.exe` (bản đóng gói). Lệnh này kiểm terminal local, SSH, Ctrl+K, menu/tab bằng bàn phím, mở lại tab và editor đang lưu bên trong Electron. Thêm `--portable` để thử chạy từ USB, vd. `node test/app-smoke.js dist\WebTerm-Portable-1.2.1.exe --portable`: file được chép sang một thư mục tạm đóng vai USB, rồi kiểm dữ liệu có nằm trong `WebTerm-data` cạnh nó không.

Muốn tự thử giao diện mà không cần VPS thật: chạy `npm run fake-sshd` rồi tạo session `127.0.0.1`, port `2222`, user `test`, mật khẩu `secret`.

## Cấu trúc

```
electron/main.js       App desktop: chạy server nội bộ, mở cửa sổ, hỏi trước khi thoát
electron/portable.js   Chạy từ USB: dữ liệu trong WebTerm-data cạnh file .exe
server.js              HTTP + WebSocket, xác thực, router API
lib/connection.js      Một tab = một phiên SSH hoặc shell local; giao thức hỏi/đáp (host key, OTP, jump host)
lib/sshclient.js       Mở kết nối SSH qua jump host, hỏi host key, keyboard-interactive
lib/tunnels.js         SSH tunnel -L/-R/-D (+ lib/socks5.js)
lib/pty.js, shells.js  Terminal local qua node-pty (ConPTY)
lib/rdp.js             Mở Remote Desktop, mật khẩu DPAPI / Credential Manager
lib/windows-powershell.js   Chạy Windows PowerShell với đường dẫn module đúng phiên bản
lib/sftp.js            Thao tác file qua SFTP; lib/zip.js + remotewalk.js: tải thư mục dạng zip
lib/probe.js           Dò thư mục hiện tại của terminal (SFTP theo terminal)
lib/editor.js          Sửa file bằng editor trên máy, tự upload khi lưu
lib/keygen.js          Tạo SSH key, cài public key lên server; lib/keypath.js: thư mục key, đường dẫn key tương đối
lib/vault.js, masterpw.js   Khoá mã hoá và master password
lib/backup.js          Sao lưu / khôi phục
lib/store.js, settings.js, macros.js   Lưu session, cài đặt, macro
public/js/             Giao diện (ES module, không cần build) + xterm.js
public/js/commands.js  Bảng truy cập nhanh Ctrl+K
public/js/tab-history.js, tab-navigation.js   Mở lại tab vừa đóng, điều hướng tab bằng bàn phím
test/                  fake-sshd, editor giả và các bộ test
```
