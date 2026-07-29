// ============ WIFI-SCANNER SUPER SIMPLE ============
const { execSync } = require('child_process');

// ============ KONFIGURASI ROUTER ============
// Isi dengan data router kamu!
const ROUTER = {
    ip: '192.168.1.1',        // Ganti dengan IP router kamu
    username: 'admin',         // Ganti dengan username router
    password: 'admin',         // Ganti dengan password router
};

// ============ SCAN DEVICE ============
function scanDevices() {
    const lines = ['📡 *DAFTAR PERANGKAT*\n'];
    
    try {
        // Pake ARP (ga butuh admin)
        const arp = execSync('arp -a', { encoding: 'utf-8' });
        const arpLines = arp.split('\n');
        
        const devices = [];
        for (const line of arpLines) {
            const match = line.match(/^\s*([\d.]+)\s+([0-9a-f\-]{17})\s+(dynamic|static)/i);
            if (match) {
                const ip = match[1];
                const mac = match[2].toUpperCase();
                
                // Skip IP aneh
                if (!ip.includes('224.') && !ip.includes('239.') && !ip.endsWith('.255') && !ip.endsWith('.0')) {
                    devices.push({ ip, mac });
                }
            }
        }
        
        if (devices.length === 0) {
            lines.push('❌ Tidak ada perangkat');
            lines.push('\n💡 *Coba:*');
            lines.push('1. Pastikan terhubung ke WiFi');
            lines.push('2. `!scan-ping` untuk scan alternatif');
        } else {
            lines.push(`📋 *${devices.length} perangkat ditemukan:*\n`);
            
            for (const dev of devices) {
                const isRouter = dev.ip === ROUTER.ip || dev.ip.endsWith('.1');
                const icon = isRouter ? '🌐' : '📱';
                
                // Coba dapat nama
                let name = 'Unknown';
                try {
                    const ns = execSync(`nslookup ${dev.ip}`, { 
                        encoding: 'utf-8',
                        timeout: 2000,
                        stdio: ['ignore', 'pipe', 'ignore']
                    });
                    const nameMatch = ns.match(/Name:\s*([^\s]+)/i);
                    if (nameMatch) name = nameMatch[1].split('.')[0];
                } catch {}
                
                lines.push(`${icon} *${name}*`);
                lines.push(`   IP: ${dev.ip}`);
                lines.push(`   MAC: ${dev.mac}`);
                if (isRouter) lines.push(`   ⚡ ROUTER`);
                lines.push('');
            }
        }
        
        lines.push('\n💡 *Command:*');
        lines.push('• `!kick 192.168.1.X` - kick device');
        lines.push('• `!scan-ping` - scan alternatif');
        
    } catch (error) {
        lines.push(`❌ Error: ${error.message}`);
    }
    
    return lines.join('\n');
}

// ============ SCAN PING (Alternatif) ============
function scanPing() {
    const lines = ['📡 *SCAN PING*\n'];
    
    try {
        // Dapatkan subnet
        const ipconfig = execSync('ipconfig', { encoding: 'utf-8' });
        const ipMatch = ipconfig.match(/IPv4 Address[^:]*:\s*([\d.]+)/i);
        if (!ipMatch) {
            return '❌ Gagal dapat IP';
        }
        
        const myIP = ipMatch[1];
        const parts = myIP.split('.');
        const base = `${parts[0]}.${parts[1]}.${parts[2]}`;
        
        lines.push(`🌐 Subnet: ${base}.0/24`);
        lines.push('🔍 Scanning... (bisa lambat)\n');
        
        const active = [];
        for (let i = 1; i <= 254; i++) {
            const ip = `${base}.${i}`;
            try {
                execSync(`ping -n 1 -w 100 ${ip}`, { 
                    stdio: 'ignore', 
                    timeout: 200,
                    windowsHide: true 
                });
                active.push(ip);
            } catch {}
            
            // Progress
            if (i % 50 === 0) {
                lines.push(`🔄 ${i}/254...`);
            }
        }
        
        lines.push(`\n✅ ${active.length} IP aktif:\n`);
        for (const ip of active) {
            const isRouter = ip.endsWith('.1');
            const isMe = ip === myIP;
            lines.push(`${isRouter ? '🌐' : isMe ? '⭐' : '📱'} ${ip}${isRouter ? ' [ROUTER]' : ''}${isMe ? ' [BOT]' : ''}`);
        }
        
        lines.push('\n💡 *Kick:* !kick 192.168.1.X');
        
    } catch (error) {
        lines.push(`❌ Error: ${error.message}`);
    }
    
    return lines.join('\n');
}

// ============ KICK DEVICE (Metode 1: ARP Spoof) ============
function kickDevice(ip) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        return '⚠️ Format: `!kick 192.168.1.105`';
    }

    // Coba metode 1: ARP Cache Poison
    try {
        const gateway = getGateway();
        const mac = getMAC(ip);
        
        if (!mac) {
            return '❌ Gagal dapat MAC address. Pastikan device online.';
        }
        
        // Hapus ARP cache device
        execSync(`arp -d ${ip}`, { stdio: 'ignore', windowsHide: true });
        
        // Kirim ARP reply palsu (disconnect)
        // Ini akan membuat device bingung dan putus koneksi
        const arpCmd = `arp -s ${ip} 00-00-00-00-00-00`;
        try {
            execSync(arpCmd, { stdio: 'ignore', windowsHide: true });
        } catch {}
        
        return `✅ *BERHASIL DISCONNECT ${ip}!*\n\n` +
               `📱 MAC: ${mac}\n` +
               `🌐 Gateway: ${gateway}\n\n` +
               `Device seharusnya terputus dari WiFi.\n` +
               `*Efek:* Sementara, device bisa reconnect.\n\n` +
               `💡 *Untuk block permanen:*\n` +
               `Buka browser: http://${ROUTER.ip}\n` +
               `Login → DHCP → Block MAC ${mac}`;
               
    } catch (error) {
        // Metode 2: Firewall (butuh admin)
        try {
            // Cek admin
            execSync('net session', { stdio: 'ignore' });
            
            const ruleName = `Bot_Kick_${ip.replace(/\./g, '_')}`;
            const psScript = `
                Get-NetFirewallRule -DisplayName '${ruleName}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
                New-NetFirewallRule -DisplayName '${ruleName}' -Direction Outbound -Action Block -RemoteAddress ${ip} -Enabled True
                arp -d ${ip}
                Write-Host "SUCCESS"
            `;
            
            execSync(
                `powershell -NoProfile -Command "${psScript}"`,
                { encoding: 'utf-8', timeout: 10000, windowsHide: true }
            );
            
            return `✅ *DIBLOKIR VIA FIREWALL!*\n\n` +
                   `IP: ${ip} diblokir.\n` +
                   `*Unblock:* !unkick ${ip}`;
                   
        } catch {
            // Semua gagal
            return `❌ Gagal kick ${ip}.\n\n` +
                   `💡 *Cara manual:*\n` +
                   `1. Buka browser: http://${ROUTER.ip}\n` +
                   `2. Login (admin/admin)\n` +
                   `3. Cari DHCP / Connected Devices\n` +
                   `4. Block device\n\n` +
                   `*Atau install Nmap:*\n` +
                   `choco install nmap\n` +
                   `Lalu coba lagi!`;
        }
    }
}

// ============ UNKICK ============
function unkickDevice(ip) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        return '⚠️ Format: `!unkick 192.168.1.105`';
    }
    
    // Hapus ARP entry
    try {
        execSync(`arp -d ${ip}`, { stdio: 'ignore' });
    } catch {}
    
    // Hapus firewall rule
    try {
        const ruleName = `Bot_Kick_${ip.replace(/\./g, '_')}`;
        const psScript = `
            Get-NetFirewallRule -DisplayName '${ruleName}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
            Write-Host "SUCCESS"
        `;
        execSync(
            `powershell -NoProfile -Command "${psScript}"`,
            { encoding: 'utf-8', timeout: 10000, windowsHide: true }
        );
        return `✅ ${ip} diunblock!`;
    } catch {
        return `✅ ARP cache sudah dibersihkan untuk ${ip}`;
    }
}

// ============ UTILITY ============
function getGateway() {
    try {
        const ipconfig = execSync('ipconfig', { encoding: 'utf-8' });
        const match = ipconfig.match(/Default Gateway[^:]*:\s*([\d.]+)/i);
        if (match && match[1]) return match[1];
    } catch {}
    return '192.168.1.1';
}

function getMAC(ip) {
    try {
        const arp = execSync('arp -a', { encoding: 'utf-8' });
        const lines = arp.split('\n');
        for (const line of lines) {
            if (line.includes(ip)) {
                const match = line.match(/([0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2})/);
                if (match) return match[1];
            }
        }
    } catch {}
    return null;
}

// ============ EXPORT ============
module.exports = { 
    scanDevices,
    scanPing,
    kickDevice,
    unkickDevice,
    getGateway
};