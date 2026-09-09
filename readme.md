# KODM Altyapı Monitör

Three.js tabanlı, tek ekranlık (kiosk) gerçek zamanlı ağ + sunucu izleme paneli.
Kaydırmasız tasarım — TV/ekranda sürekli yayına uygun. **Sahte/demo veri yok**, her değer gerçek ölçüm.

## İzlenenler

| Hedef | Bilgi | Yöntem |
|---|---|---|
| `192.168.41.252` (server2, Windows) | ping, portlar (445/139/3389/80/443/22/8080), CPU/RAM/disk, aktif TCP bağlantıları, SMB oturumları + açık dosyalar | ping + TCP tarama + server2 ajanı |
| `192.168.41.1` (modem) + internet | modem ping, Google/Cloudflare ping + kayıp %, DNS süresi, dış IP, saatlik hız testi | backend ölçümü |
| AP `192.168.41.210` (Tenda) | kablolu/kablosuz istemci listesi (35+ cihaz) | AP web arayüzü girişi |
| Ağdaki cihazlar | IP/MAC/üretici, ping, tür rengi (🔴 altyapı • 🔵 kablosuz • 🟠 kablolu) | ARP tarama + AP + MAC-OUI |

3D sahnede server'a uzanan iplikler = o anki **gerçek aktif bağlantılar** (renk = cihaz türü).

## Çalıştırma

```bash
npm install
AP_PASS=<ap-şifresi> node server.js
# aç: http://localhost:4000  (port doluysa: PORT=4001 node server.js)
```

Ortam değişkenleri:

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | 4000 | backend portu |
| `AP_PASS` | — | Tenda AP admin şifresi (kablolu/kablosuz ayrımı için) |
| `AP_IP` | 192.168.41.210 | AP adresi |
| `MODEM_IP` | 192.168.41.1 | modem adresi |
| `SUBNET` | 192.168.41 | taranan subnet |
| `SSH_USER` / `SSH_PASS` / `SSH_KEY_PATH` | — | hedef Linux ise sistem yükü için (22 açık olmalı) |
| `SERVER2_URL` | http://192.168.41.252:9419/smb | server2 ajan adresi |

## server2 Ajanı (Windows)

`agent-server2.ps1` dosyası server2'de çalışır, SMB oturumları + açık dosyalar +
sistem yükü + TCP bağlantılarını yayınlar. Kurulum (server2'de yönetici PowerShell):

```powershell
# dosyayı C:\kodm\agent-server2.ps1 olarak kopyalayın, sonra:
schtasks /create /tn "KODM Agent" /tr "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\kodm\agent-server2.ps1" /sc onstart /ru SYSTEM /rl highest /f
schtasks /run /tn "KODM Agent"
```

Test: `http://127.0.0.1:9419/smb`

## Dosyalar

- `index.html` / `style.css` / `main.js` — panel + Three.js sahnesi
- `server.js` — backend (ping, port, SSH, AP, internet, hız testi, cihaz taraması)
- `agent-server2.ps1` — Windows ajan scripti
- `package.json` — bağımlılıklar (express, cors, ssh2, multicast-dns)

## Ölçüm aralıkları

Sunucu 60 sn • internet 15 sn • hız testi saatte 1 • cihaz taraması 60 sn • paylaşım oturumları 60 sn
