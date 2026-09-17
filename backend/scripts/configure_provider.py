"""Create a provider profile in the real application database.

Until there is a settings UI, this is how a provider gets configured. It uses the
application's own stores — the same ``ProfileStore`` and credential store the HTTP
API uses — so a profile created here is indistinguishable from one created later
through the UI.

**Run this in your own terminal, not through an agent.** The API key is read
without echo and written straight to the OS credential store. It is never printed,
never written to a file, and never passed as a command-line argument, so it cannot
end up in a shell history or a transcript.

    python scripts/configure_provider.py

Or non-interactively, taking the key from an environment variable you set in your
own shell:

    python scripts/configure_provider.py --name DeepSeek \\
        --base-url https://api.deepseek.com/v1 --model deepseek-chat \\
        --key-env DEEPSEEK_API_KEY

A keyless profile — a local Ollama, LM Studio or vLLM server — is fully supported:
leave the key blank, or pass ``--keyless``.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import Settings  # noqa: E402
from app.db import bootstrap_database  # noqa: E402
from app.security.credentials import CredentialStoreUnavailableError  # noqa: E402
from app.storage.profiles import ProfileStore  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--name", help="display name for the profile")
    parser.add_argument("--base-url", help="OpenAI-compatible base URL, used verbatim")
    parser.add_argument("--model", help="model name to send")
    parser.add_argument(
        "--protocol",
        default="auto",
        choices=["auto", "chat_completions", "responses"],
        help="auto probes once and caches the result (default)",
    )
    parser.add_argument(
        "--key-env",
        help="name of an environment variable holding the API key, for non-interactive use",
    )
    parser.add_argument(
        "--keyless", action="store_true", help="store no credential at all"
    )
    return parser.parse_args()


def prompt(question: str, provided: str | None, default: str | None = None) -> str:
    if provided:
        return provided
    suffix = f" [{default}]" if default else ""
    answer = input(f"{question}{suffix}: ").strip()
    return answer or (default or "")


def read_key(args: argparse.Namespace) -> str | None:
    """Obtain the key without ever echoing, logging or arguing it."""
    if args.keyless:
        return None

    if args.key_env:
        value = os.environ.get(args.key_env)
        if not value:
            print(
                f"error: {args.key_env} is not set in this shell. Set it first, or run "
                "without --key-env to be prompted.",
                file=sys.stderr,
            )
            raise SystemExit(2)
        return value

    import getpass

    try:
        # No echo: the key never appears on screen, in a transcript, or in
        # anything that records typed input.
        value = getpass.getpass(
            "API key (leave blank for a keyless local server): "
        ).strip()
    except (EOFError, KeyboardInterrupt):
        print("\ncancelled", file=sys.stderr)
        raise SystemExit(130) from None

    return value or None


def main() -> int:
    args = parse_args()
    settings = Settings()

    print(f"database : {settings.database_path}")
    print("credential: OS credential store (never the database)")
    print()

    name = prompt("Profile name", args.name, "My Provider")
    base_url = prompt("Base URL (used verbatim, no rewriting)", args.base_url)
    model = prompt("Model", args.model)

    if not name or not base_url or not model:
        print("error: name, base URL and model are all required.", file=sys.stderr)
        return 2

    api_key = read_key(args)

    connection = bootstrap_database(settings.database_path)
    try:
        store = ProfileStore(connection)
        try:
            profile = store.create_profile(
                name=name,
                base_url=base_url,
                model=model,
                protocol=args.protocol,
                api_key=api_key,
            )
        except CredentialStoreUnavailableError as exc:
            print(f"error: could not store the credential — {exc}", file=sys.stderr)
            return 3
        except Exception as exc:  # noqa: BLE001 - reported, not swallowed
            print(f"error: {exc}", file=sys.stderr)
            return 1
    finally:
        connection.close()

    print()
    print(f"created profile {profile.id}")
    print(f"  name     : {profile.name}")
    print(f"  base_url : {profile.base_url}")
    print(f"  model    : {profile.model}")
    print(f"  protocol : {profile.protocol}")
    print(f"  has_key  : {profile.has_key}")
    if profile.has_key:
        print(f"  key      : {profile.api_key_masked}")
    else:
        # Plain ASCII throughout the output: a Windows console on a GBK code page
        # renders an em dash as mojibake, and this script's whole job is to be
        # unambiguous about what it stored.
        print("  key      : none (a keyless local server is a supported configuration)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
