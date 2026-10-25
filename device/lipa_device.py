#!/usr/bin/env python3
# lipa_device.py: install, launch and follow an app on an iOS device from Linux.
#
# Copyright (C) 2026 Matteo Ricupero
#
# This program is free software: you can redistribute it and/or modify it under
# the terms of the GNU General Public License as published by the Free Software
# Foundation, either version 3 of the License, or (at your option) any later
# version. See device/LICENSE.
#
# The device is reached through its RemotePairing service, so it works over a
# network address (Tailscale, LAN) as well as over USB. The record created once
# with `pymobiledevice3 lockdown remotepairing --pair` decides which devices are
# accepted.
#
# Events go to stdout as one JSON object per line. Log lines of the app are
# written to stdout as text, after the "launched" event, so a caller can pass
# them through unchanged.

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from pymobiledevice3.exceptions import ConnectionTerminatedError, PyMobileDevice3Exception
from pymobiledevice3.remote import tunnel_service, userspace_tunnel
from pymobiledevice3.remote.tunnel_service import (
    create_core_device_tunnel_service_using_remotepairing,
)
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.process_control import ProcessControl
from pymobiledevice3.services.installation_proxy import InstallationProxyService
from pymobiledevice3.services.mobile_image_mounter import MobileImageMounterService, auto_mount_personalized
from pymobiledevice3.services.os_trace import OsTraceService

FIRST_PORT = 49152
LAST_PORT = 49407
PROBE_CONCURRENCY = 8
PROBE_TIMEOUT = 2.0


def emit(**event: Any) -> None:
    print(json.dumps(event), flush=True)


def fail(message: str, code: int = 1) -> None:
    emit(event="error", message=message)
    raise SystemExit(code)


async def pair_verify(host: str, port: int, udid: str) -> bool:
    service = None
    try:
        service = await asyncio.wait_for(
            create_core_device_tunnel_service_using_remotepairing(udid, host, port, autopair=False),
            timeout=PROBE_TIMEOUT,
        )
        return True
    except (ConnectionTerminatedError, PyMobileDevice3Exception, OSError, asyncio.TimeoutError):
        return False
    finally:
        if service is not None:
            await service.close()


async def find_port(host: str, udid: str) -> int:
    ports = list(range(FIRST_PORT, LAST_PORT + 1))
    limit = asyncio.Semaphore(PROBE_CONCURRENCY)

    async def attempt(port: int) -> int | None:
        async with limit:
            return port if await pair_verify(host, port, udid) else None

    for start in range(0, len(ports), PROBE_CONCURRENCY * 4):
        found = await asyncio.gather(*(attempt(port) for port in ports[start : start + PROBE_CONCURRENCY * 4]))
        ports_found = [port for port in found if port is not None]

        if ports_found:
            return min(ports_found)

    fail(f"No RemotePairing service answered on {host} between {FIRST_PORT} and {LAST_PORT}")


def force_remote_pairing(host: str, port: int, udid: str) -> None:
    async def provider(serial: str | None, autopair: bool, remotepairing_fallback: bool = True):
        service = await create_core_device_tunnel_service_using_remotepairing(
            udid, host, port, autopair=False
        )
        return service, None

    userspace_tunnel._create_no_root_tunnel_provider = provider


async def open_device(host: str, port: int | None, udid: str):
    chosen = port
    if chosen is None:
        chosen = await find_port(host, udid)
        emit(event="port", port=chosen)

    force_remote_pairing(host, chosen, udid)
    tunnel = userspace_tunnel.UserspaceRsdTunnel(serial=udid)
    rsd = await tunnel.aopen()
    return tunnel, rsd


async def ensure_developer_image(rsd) -> None:
    mounter = MobileImageMounterService(lockdown=rsd)

    if await mounter.is_image_mounted("Personalized"):
        return

    emit(event="image", state="mounting")
    await auto_mount_personalized(rsd)


async def launch(rsd, bundle_id: str, ipa: Path | None) -> int:
    if ipa is not None:
        emit(event="install", state="start", ipa=str(ipa))
        await InstallationProxyService(lockdown=rsd).install_from_local(
            ipa, developer=True, handler=lambda percent, *_: None
        )
        emit(event="install", state="done")

    await ensure_developer_image(rsd)

    async with DvtProvider(rsd) as dvt, ProcessControl(dvt) as control:
        pid = await control.launch(bundle_id)

    emit(event="launched", bundle_id=bundle_id, pid=pid)
    return pid


async def follow_logs(rsd, pid: int, bundle_id: str, everything: bool) -> None:
    async for entry in OsTraceService(lockdown=rsd).syslog(pid=pid):
        label = entry.label
        subsystem = getattr(label, "subsystem", None) if label is not None else None

        if not everything and subsystem != bundle_id:
            continue

        category = getattr(label, "category", "") if label is not None else ""
        print(f"[{category}] {entry.message}", flush=True)


async def probe(rsd) -> None:
    mounter = MobileImageMounterService(lockdown=rsd)
    emit(
        event="probe",
        udid=rsd.udid,
        version=rsd.product_version,
        image_mounted=await mounter.is_image_mounted("Personalized"),
    )


async def main() -> None:
    parser = argparse.ArgumentParser(description="Install, launch and follow an app on an iOS device.")
    parser.add_argument("--host", required=True, help="Address of the device, for example its tailnet name")
    parser.add_argument("--port", type=int, default=None, help="RemotePairing port, found when missing")
    parser.add_argument("--udid", required=True, help="Device UDID")
    parser.add_argument("--bundle-id", default=None, help="Bundle id to launch and follow")
    parser.add_argument("--ipa", type=Path, default=None, help="IPA to install first")
    parser.add_argument("--no-logs", action="store_true", help="Stop after the launch")
    parser.add_argument(
        "--logs",
        choices=("app", "all"),
        default="app",
        help="app keeps the entries of the bundle id only, all keeps every process entry",
    )
    parser.add_argument("--probe", action="store_true", help="Report the device and exit")
    arguments = parser.parse_args()

    tunnel = None
    try:
        tunnel, rsd = await open_device(arguments.host, arguments.port, arguments.udid)

        if arguments.probe:
            await probe(rsd)
            return

        if arguments.bundle_id is None:
            fail("--bundle-id is required unless --probe is given")

        pid = await launch(rsd, arguments.bundle_id, arguments.ipa)

        if arguments.no_logs:
            return

        await follow_logs(rsd, pid, arguments.bundle_id, arguments.logs == "all")
    except PyMobileDevice3Exception as error:
        fail(str(error), 9)
    except KeyboardInterrupt:
        pass
    finally:
        if tunnel is not None:
            await tunnel.aclose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
