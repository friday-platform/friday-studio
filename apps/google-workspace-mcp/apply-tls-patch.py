#!/usr/bin/env python3
"""
Patch workspace-mcp main.py to support TLS via SSL_KEYFILE and SSL_CERTFILE env vars.

Upstream workspace-mcp does not support TLS natively. This patch injects
uvicorn_config with ssl_keyfile/ssl_certfile into the server.run() call.
"""

import site
import sys
from pathlib import Path


def patch_main_py():
    site_packages = Path(site.getsitepackages()[0])
    main_py = site_packages / "main.py"

    if not main_py.exists():
        print(f"ERROR: {main_py} not found", file=sys.stderr)
        sys.exit(1)

    content = main_py.read_text()

    # Check if already patched
    if "SSL_KEYFILE" in content:
        print("Already patched, skipping")
        return

    # Find the server.run() call for streamable-http (workspace-mcp 1.14.x)
    old_code = 'server.run(transport="streamable-http", host=host, port=port)'

    if old_code not in content:
        print("ERROR: Could not find server.run() pattern to patch", file=sys.stderr)
        for i, line in enumerate(content.splitlines()):
            if "server.run" in line:
                print(f"  Line {i+1}: {line}", file=sys.stderr)
        sys.exit(1)

    new_code = '''# TLS configuration from environment variables
            ssl_keyfile = os.getenv("SSL_KEYFILE")
            ssl_certfile = os.getenv("SSL_CERTFILE")
            uvicorn_config = {}
            if ssl_keyfile and ssl_certfile:
                uvicorn_config["ssl_keyfile"] = ssl_keyfile
                uvicorn_config["ssl_certfile"] = ssl_certfile
                safe_print(f"TLS enabled: keyfile={ssl_keyfile}, certfile={ssl_certfile}")

            server.run(transport="streamable-http", host=host, port=port, uvicorn_config=uvicorn_config if uvicorn_config else None)'''

    new_content = content.replace(old_code, new_code)
    main_py.write_text(new_content)
    print(f"Successfully patched {main_py} for TLS support")


if __name__ == "__main__":
    patch_main_py()
