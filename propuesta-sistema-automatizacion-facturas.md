# Sistema de Clasificacion

**Cliente:** Alupar | La Virgen  
**Fecha:** 10 de abril de 2026  
**Tipo de entrega:** Monto cerrado por entregable  
**Inversion estimada (base):** USD 1,500 (50 USD/hora x 30 horas)  
**Plazo de ejecucion:** 4 semanas

---

## 1. Resumen ejecutivo

Este documento presenta la propuesta tecnica para automatizar la identificacion y lectura de documentos recibidos por correo (facturas, comprobantes y notas), con el fin de acelerar la preparacion de informes por concepto para el area de contabilidad.

La solucion se apoya en **Workato** para orquestar la captura de correos y en una capa de procesamiento (dentro de Workato o en Google Cloud Platform, segun configuracion optima) para clasificar el tipo de documento, extraer datos clave y organizar la salida operativa.

El resultado esperado es un tablero con **una pestana por tipo de documento** (Facturas, Comprobantes, Notas), donde cada registro muestre informacion relevante como numero, fecha de emision, monto, fecha de vencimiento y concepto. Adicionalmente, el flujo armara paquetes `.zip` agrupando los documentos por concepto, listos para ser remitidos al area de contabilidad.

---

## 2. Flujo operativo actual y oportunidad de automatizacion

### 2.1 Flujo actual

Hoy el equipo recibe correos con diferentes tipos de contenido:

- Correos con PDF adjunto (facturas, comprobantes, notas).
- Correos sin PDF adjunto.
- Correos con adjuntos que no corresponden a los conceptos objetivo.

A partir de esos correos, el proceso operativo requiere:

1. Identificar de que tipo es cada correo/documento.
2. Leer manualmente los archivos para extraer datos clave.
3. Agrupar los documentos por concepto (ejemplo: facturas de peajes).
4. Armar informes por concepto con campos como:
   - Numero de documento.
   - Fecha de emision.
   - Monto.
   - Fecha de vencimiento.
   - Otros datos requeridos por el area.
5. Comprimir en `.zip` los documentos agrupados por concepto para remitir al area de contabilidad.

### 2.2 Oportunidad de automatizacion

La propuesta busca convertir este flujo en un proceso asistido y trazable, donde el trabajo del equipo se concentre en validacion y decision, no en lectura repetitiva.

La automatizacion habilita:

- Deteccion automatica de correos con y sin adjuntos PDF.
- Clasificacion de documentos por tipo: factura, comprobante o nota.
- Extraccion automatica de datos clave desde PDF.
- Identificacion del concepto de cada documento y agrupacion por concepto.
- Visualizacion por pestanas segun tipo de documento.
- Generacion de paquetes `.zip` por concepto para envio o archivo.

---

## 3. Objetivo del proyecto

Construir un flujo automatizado que:

1. Monitoree correos entrantes y detecte adjuntos relevantes.
2. Clasifique documentos en tres categorias: Facturas, Comprobantes y Notas.
3. Extraiga informacion clave desde PDF para cada categoria.
4. Identifique el concepto operativo de cada documento.
5. Presente los datos en un dashboard con una pestana por tipo de documento.
6. Agrupe y exporte los documentos por concepto en archivos `.zip` listos para redactar el informe para contabilidad.

---

## 4. Solucion tecnica propuesta

### 4.1 Vision general de la arquitectura

La solucion se construye sobre dos pilares tecnologicos principales que trabajan en secuencia:

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  ┌──────────────────┐      ┌──────────────────────────────┐ │
│  │ CAPA DE CAPTURA  │      │   CAPA DE PROCESAMIENTO      │ │
│  │   (Workato)      │─────▶│   Y PRESENTACION (GCP)       │ │
│  │                  │      │                              │ │
│  │ • Monitor de     │      │ • Document AI (lectura PDF)  │ │
│  │   correos        │      │ • Cloud Functions            │ │
│  │ • Filtros de     │      │   (clasificacion y concepto) │ │
│  │   adjuntos       │      │ • Firestore (base de datos)  │ │
│  │ • Descarga y     │      │ • Cloud Storage (PDFs)       │ │
│  │   envio a GCP    │      │ • Dashboard web              │ │
│  └──────────────────┘      └──────────────────────────────┘ │
│         │                               │                    │
│   Correo (Outlook)                Panel web por pestana      │
│   (fuente de datos)         (usuario que genera el informe)  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Workato** actua como punto de entrada: monitorea el correo, detecta mensajes con adjuntos PDF relevantes, los descarga y los envia a Google Cloud para procesamiento. No lee ni interpreta el contenido del PDF; su rol es la orquestacion.

**Google Cloud Platform** concentra toda la inteligencia del sistema: lee el contenido del PDF mediante Document AI, clasifica el tipo de documento, extrae los campos clave, identifica el concepto y almacena el resultado estructurado. Tambien expone el dashboard web donde contabilidad visualiza y opera sobre los datos.

### 4.2 Stack tecnologico

#### Workato — Orquestacion de correos y captura de adjuntos

**Workato** es una plataforma de automatizacion de procesos empresariales especializada en la integracion entre herramientas de negocio como Outlook, Gmail, Google Cloud y bases de datos. En esta solucion su rol se limita a la capa de captura, que es donde realmente aporta valor:

1. **Escucha activa del correo**: monitorea el buzon configurado de forma continua. Cuando llega un nuevo email, Workato lo evalua de inmediato.

2. **Filtrado inicial**: determina si el correo tiene adjuntos en formato PDF. Los correos sin adjunto PDF se registran aparte (para visibilidad) pero no ingresan al flujo de procesamiento de documentos.

3. **Descarga y envio a GCP**: descarga el archivo adjunto y lo envia a Google Cloud Storage junto con los metadatos del correo (remitente, fecha de recepcion, asunto). A partir de ese punto, GCP toma el control.

Workato fue elegido para esta capa porque cuenta con conectores nativos a los principales clientes de correo (Outlook, Gmail) y a Google Cloud, requiere configuracion visual sin codigo, y permite ajustar reglas de filtrado sin reprogramacion.

> **Por que Workato no lee los PDF:** Workato es una plataforma de integracion y orquestacion, no un motor de procesamiento de documentos. No tiene capacidades nativas para extraer texto estructurado de un PDF ni para distinguir si un documento es una factura, un comprobante o una nota. Intentar hacer eso dentro de Workato implicaria llamadas externas complejas y resultados poco confiables. Para esa tarea existe Document AI, que es el servicio de Google disenado especificamente para eso.

#### Google Cloud Document AI — Lectura e interpretacion de documentos PDF

**Document AI** es el servicio de Google Cloud disenado especificamente para leer, estructurar y extraer informacion de documentos como facturas, recibos y comprobantes. Es el componente central de la inteligencia de esta solucion.

Cuando recibe un PDF, Document AI:

1. Extrae todo el texto del documento, incluso en documentos con formatos variables o multiples columnas.
2. Identifica bloques semanticos: encabezados, tablas, pies de pagina, sellos, montos, fechas.
3. Aplica modelos preentrenados (o un modelo ajustado al tipo de documentos del cliente) para extraer campos clave con alta precision:
   - Numero de documento.
   - Fecha de emision.
   - Fecha de vencimiento.
   - Monto total.
   - Emisor del documento.
4. Retorna una respuesta estructurada en JSON que Cloud Functions consume para completar la clasificacion.

La eleccion de Document AI sobre alternativas mas simples (como librerias de extraccion de texto genericas) se justifica en que los documentos financieros tienen variabilidad alta: distintos formatos, posiciones de campos, idiomas y calidades de escaneo. Document AI esta entrenado para ese contexto especifico y reduce significativamente la tasa de errores en la extraccion.

#### Google Cloud Functions — Clasificacion por tipo e identificacion de concepto

Luego de que Document AI extrae los campos del PDF, una **Cloud Function** recibe esa informacion estructurada y aplica la logica de negocio:

1. **Clasificacion por tipo de documento**: en base al contenido extraido (palabras clave, estructura, campos presentes), determine si el documento es una Factura, un Comprobante o una Nota.

2. **Identificacion del concepto**: lee campos como el emisor, la descripcion del servicio o el tipo declarado en el documento y lo mapea contra una tabla de conceptos configurada por el equipo (ejemplo: "peaje", "servicio electrico", "transporte", etc.).

3. **Registro del resultado**: almacena el documento procesado en Firestore con todos los campos extraidos y el resultado de clasificacion.

4. **Generacion del ZIP**: agrupa los PDFs por concepto en Cloud Storage y genera el archivo `.zip` correspondiente para descarga y generar el informe dirigido a contabilidad.

Las Cloud Functions son serverless: solo se ejecutan cuando hay un documento nuevo para procesar, no consumen recursos cuando no hay actividad, y escalan automaticamente si el volumen de correos aumenta.

#### Google Cloud Firestore — Base de datos de documentos procesados

**Firestore** almacena el registro estructurado de cada documento procesado:

| Campo | Descripcion |
|---|---|
| `id` | Identificador unico del documento |
| `fecha_recepcion` | Fecha y hora de llegada del correo |
| `remitente` | Direccion de correo origen |
| `tipo_documento` | Factura / Comprobante / Nota |
| `numero_documento` | Numero extraido por Document AI |
| `fecha_emision` | Fecha del documento |
| `fecha_vencimiento` | Fecha de vencimiento (si aplica) |
| `monto` | Monto total extraido |
| `concepto` | Concepto identificado |
| `archivo_pdf` | Referencia al PDF en Cloud Storage |
| `archivo_zip` | Referencia al ZIP del concepto |
| `estado` | Pendiente / Revisado / Procesado |

Firestore es el origen de datos que alimenta el dashboard en tiempo real.

#### Google Cloud Storage — Almacenamiento de PDFs y ZIPs

**Cloud Storage** almacena los archivos originales recibidos y los paquetes de salida:

- Carpeta `documentos/`: PDF originales organizados por fecha de recepcion.
- Carpeta `exports/`: archivos `.zip` por concepto, listos para descarga.

Esto garantiza que los documentos queden disponibles de forma permanente independientemente del correo original.

#### Cloud Run / App Engine — Dashboard web

El dashboard es una aplicacion web liviana desplegada en la nube sobre **Cloud Run**, que consulta Firestore y presenta la informacion operativa.

Contenido del dashboard:

- **Pestana Facturas**: tabla con todos los documentos clasificados como factura, filtrable por concepto, fecha y estado.
- **Pestana Comprobantes**: tabla equivalente para comprobantes.
- **Pestana Notas**: tabla equivalente para notas.
- **Vista de detalle**: al hacer clic en un registro, muestra los campos extraidos y permite acceder al PDF original.
- **Descarga de ZIP por concepto**: boton por concepto para descargar el paquete de documentos agrupados.
- **Cambio de estado manual**: permite marcar documentos como revisados o procesados.

El panel se actualiza en tiempo real: cada vez que Workato detecta un correo nuevo y GCP lo procesa, el registro aparece en la pestana correspondiente sin necesidad de recargar manualmente.

### 4.3 Flujo completo de operacion

```
Llega un correo al buzon
        │
        ▼
[Workato detecta el correo]
        │
        ├── ¿Tiene adjunto PDF? ──► NO ──► Registra correo sin adjunto y termina
        │
       SÍ
        │
        ▼
[Workato descarga el PDF y lo sube a Cloud Storage]
        │
        ▼
[Cloud Function se activa con el nuevo archivo]
        │
        ▼
[Document AI lee el PDF y extrae campos estructurados]
        │
        ▼
[Cloud Function clasifica: Factura / Comprobante / Nota]
[Cloud Function identifica el concepto]
        │
        ▼
[Se guarda el registro en Firestore]
[Se agrega el PDF al ZIP del concepto en Cloud Storage]
        │
        ▼
[Dashboard web refleja el nuevo documento en la pestana correspondiente]
```

---

## 5. Beneficios de la solucion

1. **Mayor velocidad operativa:** reduce tiempos de lectura y clasificacion manual de correos/documentos.
2. **Mejor consistencia de criterios:** aplica reglas estandarizadas para tipo documental y concepto.
3. **Salida lista para gestion:** facilita informes por concepto y armado de paquetes `.zip`.
4. **Trazabilidad del proceso:** centraliza en un dashboard los documentos procesados y su estado.

---

## 6. Alcance del proyecto base (30 horas)

### Incluye

1. Configuracion de flujo Workato para captura de correos entrantes.
2. Deteccion de correos con adjunto PDF y correos sin adjunto.
3. Clasificacion inicial por tipo documental: Factura, Comprobante, Nota.
4. Extraccion de campos clave de documentos PDF (segun estructura disponible).
5. Regla de identificacion de concepto y agrupacion de documentos por concepto.
6. Dashboard con 3 pestanas por tipo de documento.
7. Generacion de `.zip` por concepto para documentos que cumplan criterio.
8. Prueba funcional con muestra de correos/documentos provistos por el cliente.

### No incluye en esta propuesta base

1. Entrenamiento avanzado de modelos de IA para documentos no estructurados complejos.
2. Integraciones con ERP/contabilidad.
3. Flujos multi-aprobacion con firmas o circuitos jerarquicos.
4. Soporte de larga duracion post entrega (solo soporte inicial definido en condiciones).

---

## 7. Alcance adicional opcional (extra)

### Boton de generacion de informe con LLM

Como alcance adicional, se puede incorporar una funcionalidad con boton en el dashboard para generar automaticamente el informe que sera enviado por correo.

Al presionar el boton:

1. Se toma el conjunto filtrado por concepto.
2. Se invoca una LLM con plantilla de redaccion controlada.
3. Se genera un borrador del informe con:
   - Resumen ejecutivo del lote.
   - Lista de documentos y campos clave.
   - Observaciones detectadas (si aplica).
4. Se deja listo para revision humana y envio.

**Esfuerzo adicional:** 8 horas  
**Costo adicional:** USD 400 (50 USD/hora x 8 horas)

---

## 8. Distribucion horaria

### Proyecto base

| Actividad | Horas estimadas |
|---|---:|
| Levantamiento tecnico y mapeo de conceptos | 3.0 h |
| Configuracion Workato (captura, filtros, enrutamiento) | 4.0 h |
| Lectura y clasificacion de PDFs (Workato + GCP) | 8.0 h |
| Reglas de identificacion de concepto + agrupacion | 4.0 h |
| Dashboard (3 pestanas) + salida consolidada por concepto | 7.0 h |
| Generacion automatica de ZIP por concepto | 2.0 h |
| Pruebas funcionales + ajustes | 1.5 h |
| Documentacion y entrega | 0.5 h |
| **Total base** | **30.0 h** |

### Adicional opcional

| Actividad extra | Horas estimadas |
|---|---:|
| Boton y flujo LLM para generacion de informe | 8.0 h |
| **Total adicional** | **8.0 h** |

---

## 9. Condiciones de entrega

- **Inversion base:** USD 1,500 — pago en dos hitos: 50% al inicio del proyecto, 50% a la entrega validada.
- **Adicional opcional LLM:** USD 400 si se aprueba y ejecuta el alcance de generacion de informe.
- **Soporte inicial:** 3 dias calendario posteriores a la entrega para ajustes menores y consultas.
- **Cambios fuera de alcance:** se evaluan y cotizan por separado.
