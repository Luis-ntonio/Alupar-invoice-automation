"""
Cliente para consulta individual de comprobantes SUNAT.

Flujo descubierto:
1. GET /consulta  → obtiene cookies de sesión
2. Genera token random de 52 chars (la lib sunatrecaptcha3.js de SUNAT es fake:
   solo hace Math.random().toString(36).substring(2) hasta completar 52 chars)
3. POST /consultaIndividual con multipart/form-data + cookies

Campos del formulario:
  numRuc       - RUC del emisor (11 dígitos)
  codComp      - Tipo comprobante: 01=Factura, 03=Boleta, 07=NC, 08=ND,
                   R1=Honorarios, R7=NC Honorarios, 04=Liquidación, 23=Póliza
  numeroSerie  - Serie (4 chars, ej. F001, B001)
  numero       - Número del comprobante (hasta 8 dígitos)
  codDocRecep  - Tipo doc receptor: ""=Sin doc, 6=RUC, 1=DNI, 4=CE, 7=Pasaporte
  numDocRecep  - Número de documento del receptor
  fechaEmision - Fecha DD/MM/YYYY
  monto        - Importe total (requerido para comprobantes electrónicos)
  token        - Token fake generado localmente
"""

import random
import string
import requests

BASE_URL = "https://ww1.sunat.gob.pe/ol-ti-itconsultaunificadalibre/consultaUnificadaLibre"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-PE,es;q=0.9,en;q=0.8",
    "Origin": "https://ww1.sunat.gob.pe",
    "Referer": f"{BASE_URL}/consulta",
}


def _generar_token(longitud: int = 52) -> str:
    """
    Replica la función generateKey(52) de sunatrecaptcha3.js:
        Math.random().toString(36).substring(2) -> chars 0-9 a-z
    """
    chars = string.digits + string.ascii_lowercase
    return "".join(random.choices(chars, k=longitud))


def consultar_comprobante(
    num_ruc: str,
    cod_comp: str,
    numero_serie: str,
    numero: str,
    fecha_emision: str,
    monto: str = "",
    cod_doc_recep: str = "",
    num_doc_recep: str = "",
) -> dict:
    """
    Consulta la validez de un comprobante de pago en SUNAT.

    Args:
        num_ruc:       RUC del emisor (11 dígitos)
        cod_comp:      Código de tipo comprobante (ver docstring del módulo)
        numero_serie:  Serie del comprobante (ej. "F001")
        numero:        Número del comprobante (ej. "18614")
        fecha_emision: Fecha en formato DD/MM/YYYY (ej. "15/01/2026")
        monto:         Importe total (obligatorio para electrónicos)
        cod_doc_recep: Código de tipo documento receptor (default vacío)
        num_doc_recep: Número de documento del receptor

    Returns:
        dict con la respuesta JSON de SUNAT.
        Claves relevantes:
          - rpta: "1" = encontrado, otros = error/no existe
          - data: dict con estadoCp, estadoRuc, condicion, etc.

    Raises:
        requests.HTTPError: si el servidor devuelve error HTTP.
    """
    session = requests.Session()
    session.headers.update(HEADERS)

    # ── Paso 1: GET /consulta para obtener las cookies de sesión ────────────
    resp_get = session.get(f"{BASE_URL}/consulta", timeout=15)
    resp_get.raise_for_status()

    # ── Paso 2: Generar token (reCAPTCHA falso de SUNAT) ────────────────────
    token = _generar_token(52)

    # ── Paso 3: POST /consultaIndividual con multipart/form-data ────────────
    data = {
        "numRuc": num_ruc,
        "codComp": cod_comp,
        "numeroSerie": numero_serie.upper(),
        "numero": numero,
        "codDocRecep": cod_doc_recep,
        "numDocRecep": num_doc_recep,
        "fechaEmision": fecha_emision,
        "monto": monto,
        "token": token,
    }

    resp_post = session.post(
        f"{BASE_URL}/consultaIndividual",
        data=data,           # multipart/form-data (no json=, no urlencode)
        timeout=20,
    )
    resp_post.raise_for_status()

    # SUNAT devuelve el body como un string JSON serializado dos veces:
    # el Content-Type dice application/json pero el cuerpo es una cadena
    # con comillas externas: "{\"data\":{...},\"rpta\":1}"
    import json
    raw = resp_post.json()          # primer parse: da una str
    if isinstance(raw, str):
        raw = json.loads(raw)       # segundo parse: da el dict real
    return raw


# ── Ejemplo de uso ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    resultado = consultar_comprobante(
        num_ruc="20601053391",
        cod_comp="01",           # Factura
        numero_serie="FF01",
        numero="2311",
        fecha_emision="22/01/2024",
        monto="1270.99",
        cod_doc_recep="6",       # RUC
        num_doc_recep="20492925030",
    )

    import json
    print(json.dumps(resultado, ensure_ascii=False, indent=2))
