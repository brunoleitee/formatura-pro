import os
import signal
import socket
import subprocess
import time


def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex(("127.0.0.1", port)) == 0


def get_port_owner_pid(port: int):
    try:
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True,
            text=True,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        return None

    target = f":{port}"
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) >= 5 and parts[0].upper() == "TCP":
            local_addr = parts[1]
            if local_addr.endswith(target):
                try:
                    return int(parts[-1])
                except (ValueError, IndexError):
                    continue
    return None


def stop_existing_backend_on_port(port: int, log_info):
    """Tenta encontrar um processo rodando na porta alvo e encerra ele."""
    for _attempt in range(3):
        pid = get_port_owner_pid(port)
        if not pid or pid == os.getpid():
            return

        log_info(f"Porta {port} em uso por PID {pid}. Encerrando para inicialização...")
        try:
            os.kill(pid, signal.SIGTERM)
            time.sleep(0.5)
            os.kill(pid, signal.SIGABRT)
        except Exception:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/F", "/T"],
                capture_output=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )

        time.sleep(1)
        if not is_port_in_use(port):
            return


def parent_watchdog(psutil_module, log_info):
    """Monitora se o processo pai ainda existe. Se o Tauri fechar, o backend morre junto."""
    try:
        time.sleep(10)

        if psutil_module:
            proc = psutil_module.Process(os.getpid())
            parent = proc.parent()
            if not parent:
                return

            parent_pid = parent.pid
            print(f"[WATCHDOG] Monitorando processo pai (psutil): {parent_pid}")

            while True:
                if not psutil_module.pid_exists(parent_pid):
                    print("[WATCHDOG] Processo pai encerrou. Finalizando backend...")
                    os._exit(0)
                time.sleep(3)
        else:
            parent_pid = os.getppid()
            if parent_pid <= 1:
                return
            print(f"[WATCHDOG] Monitorando processo pai (fallback): {parent_pid}")
            while True:
                try:
                    if parent_pid > 0:
                        os.kill(parent_pid, 0)
                    else:
                        break
                except (OSError, ProcessLookupError):
                    log_info(
                        f"[WATCHDOG] Processo pai {parent_pid} não detectado, mas mantendo servidor ativo para estabilidade."
                    )
                    break
                except Exception as err:
                    if "returned a result with an exception set" not in str(err):
                        log_info(f"[WATCHDOG] Alerta ao verificar PID {parent_pid}: {err}")
                time.sleep(5)

    except Exception as err:
        print(f"[WATCHDOG] Erro no monitoramento: {err}")
