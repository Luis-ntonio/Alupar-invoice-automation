# Sistema Automatizado de Revisión y Clasificación de Facturas

**Cliente:** Alupar | La Virgen
**Fecha:** 8 de abril de 2026
**Tipo de entrega:** Monto cerrado por entregable
**Inversión estimada:** USD 1,700 (50 USD/hora × 30 horas)
**Plazo de ejecución:** 4 semanas calendario

## 1. Resumen ejecutivo

Este documento presenta la propuesta técnica para desarrollar un sistema automatizado de revisión y clasificación de facturas que opera en tiempo real sobre el correo corporativo de Outlook. La solución fue diseñada en respuesta a un proceso manual que consume tiempo significativo y está expuesto a errores humanos en la identificación de remitentes y en el direccionamiento de documentos a los departamentos correspondientes.

El propósito central de esta iniciativa es mejorar la eficiencia operativa del proceso de revisión y clasificación de documentos, aportando visibilidad centralizada y reduciendo las tareas repetitivas de búsqueda, identificación manual y consolidación de datos.

La solución integra dos componentes tecnológicos principales: un servicio de escucha activa del correo que captura facturas de forma automática (Workato), y un panel de control web accesible donde se visualiza un resumen ejecutivo de todos los documentos pendientes con la información clave ya extraída y clasificada (Microsoft Azure).

La extracción de datos se realiza de forma nativa sobre los archivos XML en formato UBL 2.1, que es el estándar oficial de los comprobantes electrónicos emitidos en el marco del sistema SUNAT de Perú. Esto elimina la necesidad de servicios de OCR o procesamiento de documentos de terceros para el caso de uso principal. Adicionalmente, el sistema valida cada comprobante en tiempo real contra el portal libre de SUNAT, confirmando su estado fiscal antes de presentarlo al usuario, y contrasta los montos de facturas COES (VTEA/VTP) contra las liquidaciones mensuales oficiales descargadas automáticamente.

El valor generado no es únicamente la velocidad del procesamiento, sino la reducción del error operativo y la visibilidad centralizada que permite una toma de decisiones más consiente y consistente.

## 2. Exploración del flujo y oportunidad de automatización

### 2.1 Contexto operativo actual

Alupar recibe diariamente un volumen variable de facturas y recibos a través del correo de Outlook corporativo, provenientes de empresas proveedoras, clientes y contratistas externos. Actualmente existe un flujo claro de revisión que contempla:

1. Revisar cada correo recibido en el buzón general.
2. Identificar el remitente con base en:
   - El dominio del correo del emisor (a veces indicativo, a veces genérico).
   - La firma dentro del correo.
   - El sello o membrete en el documento PDF o imagen adjunto.
   - Datos dentro del documento mismo (número de identificación, membrete, etc.).
3. Identificar si el documento corresponde a una factura o a un comprobante de pago.
4. Registrar la fecha y otros detalles relevantes.
5. Consultar sistemas internos (Excel, bases de datos locales) para encontrar el mapeo entre empresa y equipo responsable.
6. Redireccionar el correo o crear un registro de derivación al equipo correspondiente.

Este flujo ya cuenta con criterios operativos definidos y experiencia del equipo en la toma de decisiones. La propuesta busca potenciar ese trabajo mediante la automatización del flujo de identificación de facturas, para que la información llegue preclasificada y consolidada en un único panel. De esta forma, el tiempo del equipo se orienta más a validación, control y seguimiento, y menos a tareas de recopilación.

### 2.2 Casos de automatización prioritaria

Dentro del flujo actual existen escenarios donde la automatización aporta mayor valor:

- Empresas con múltiples dominios de correo: un proveedor puede enviar desde direcciones diferentes; la automatización ayuda a unificar la identificación de la misma contrapartida.
- Remitentes genéricos: correos desde dominio @gmail.com o direcciones corporativas no descriptivas; el sistema puede apoyarse en contenido y adjuntos para sugerir la empresa correcta.
- Documentos sin estructura clara: algunos archivos llegan como imágenes o en formatos no estándar; la solución centraliza criterios para facilitar su revisión.
- Derivaciones entre equipos: la clasificación asistida y trazable reduce reprocesos y mejora continuidad operativa.

### 2.3 Oportunidad de mejora operativa

El tiempo dedicado a este proceso representa una oportunidad concreta para elevar productividad y foco operativo. Con automatización, la persona responsable puede dedicar más energía a tareas de mayor valor: seguimiento de facturas pendientes, validación de montos, coordinación de pagos y resolución de discrepancias contables. Además, la estandarización del flujo permite:

- Mayor continuidad del proceso, incluso en días de alto volumen de correos.
- Mejor precisión de derivación, al contar con sugerencias de clasificación basadas en reglas.
- Menor reproceso, gracias a un registro único y trazable por documento.

La solución automatiza las etapas repetitivas de captura, identificación preliminar y consolidación de información, aportando una vista clara y estructurada para la toma de decisiones.

### 2.4 Objetivo del proyecto

Construir un sistema que:

1. Escuche activamente el correo de Outlook y capture automáticamente todo email con adjuntos que cumplan criterios de factura/recibo.
2. Extraiga información clave de cada documento: remitente, fecha de envío, tipo (factura o comprobante), fecha de documento, monto (si está disponible).
3. Relacione automáticamente el remitente con la empresa origen utilizando bases de referencias (dominios de correo, perfiles de empresa).
4. Presente toda la información en un panel de control accesible donde la persona responsable vea un resumen organizado y clara de documentos pendientes.
5. Facilite la derivación permitiendo cambios de clasificación rápidos y registro de decisiones.

## 3. Solución técnica propuesta

### 3.1 Visión general de la arquitectura

La solución se construye sobre dos pilares tecnológicos principales que trabajan de forma coordinada:

- **Capa de escucha (Workato)**

  - Monitor de correos
  - Filtros inteligentes
  - Extracción de datos
- **Capa de datos y clasificación (Microsoft Azure)**

  - Base de datos
  - Reglas de clasificación
  - Mapeo de empresas

**Fuente de datos:** Correo Outlook
**Interfaz de usuario:** Panel de Control Web

Workato actúa como centinela permanente: monitorea el correo de Outlook en tiempo real, aplica filtros heurísticos para identificar documentos relevantes, extrae datos base de cada correo y lo envía hacia Microsoft Azure para su procesamiento posterior.

Microsoft Azure proporciona la capa de persistencia, análisis y presentación: almacena un registro de cada documento capturado, aplica reglas de clasificación más sofisticadas, mantiene la base de referencias de empresas, y expone un panel web donde el equipo accede a toda la información compilada. Al ser parte del mismo ecosistema Microsoft que Outlook, la autenticación del panel se integra directamente con las cuentas corporativas existentes (Microsoft Entra ID), sin necesidad de credenciales adicionales.

### 3.2 Stack tecnológico

#### Workato — Orquestación de procesos y escucha del correo

Workato es una plataforma de automatización de procesos empresariales que se especializa en la integración entre sistemas como Microsoft Outlook, Microsoft Azure, bases de datos y aplicaciones de negocio. Su rol en esta solución es triple:

1. **Escucha activa:** monitorea la bandeja de correos de Outlook de forma continua (cada 5 minutos o según se configure). Cuando llega un nuevo email, Workato lo evalúa inmediatamente.
2. **Filtrado inteligente inicial:** aplica reglas básicas para determinar si el correo contiene facturas:
   - Presencia de palabras clave en asunto ("factura", "recibo", "invoice", "comprobante", etc.).
   - Presencia de adjuntos en formatos de documento (PDF, Excel, imágenes).
   - Exclusión de ciertos dominios conocidos como internos (correos de la misma empresa).
3. **Extracción de datos preliminares:** obtiene de forma directa datos que están disponibles sin procesar el documento:
   - Remitente (dirección de correo origen).
   - Fecha de recepción.
   - Asunto del correo.
   - Nombres de archivos adjuntos.
   - Cuerpo del correo (si contiene números de factura u otros datos identificatorios).

Workato fue elegido porque cuenta con conectores nativos a Outlook y a servicios en la nube como Azure, requiere configuración mínima de código personalizado, y su interfaz de flujos visuales permite que cambios en las reglas se implementen sin requerir reprogramación.

#### Microsoft Azure — Persistencia, análisis y presentación

Microsoft Azure proporciona la infraestructura en la nube donde se centraliza la inteligencia del sistema:

- **Azure Cosmos DB (base de datos NoSQL):**

  - Almacena un registro inmutable de cada correo procesado: quién envía, cuándo, qué adjuntos contiene, qué datos se extrajeron.
  - Mantiene la tabla de referencias de empresas: dominios de correo asociados, departamentos responsables.
  - Registra decisiones y cambios de estado (cuando un documento se clasificó, quién lo hizo, a qué equipo se derivó).
- **Azure Container Apps (lógica de procesamiento y API):**

  - Implementa reglas de clasificación más complejas que las que Workato puede resolver por sí solo.
  - **Extracción nativa desde XML UBL 2.1:** los comprobantes electrónicos SUNAT se parsean directamente sin servicios externos, extrayendo: RUC del emisor, nombre del emisor, número de comprobante, fecha de emisión y vencimiento, monto, moneda, tipo de documento (factura/boleta/nota), concepto y receptor.
  - **Soporte ZIP:** los portales como efacturacion.pe entregan comprobantes en archivos ZIP. El sistema descomprime automáticamente y procesa los XML y PDF contenidos.
  - **Validación SUNAT en tiempo real:** cada comprobante se consulta contra el portal libre de SUNAT (`consultaUnificadaLibre`) para obtener el estado del comprobante (ACEPTADO / ANULADO / NO EXISTE), el estado del contribuyente (ACTIVO / BAJA DEFINITIVA / etc.) y la condición de domicilio (HABIDO / NO HABIDO / etc.).
  - **Prevalidación de montos COES:** para facturas de Peajes y transferencias COES (VTEA/VTP), el sistema descarga automáticamente las liquidaciones mensuales oficiales de COES, identifica el informe correspondiente y cruza el monto facturado contra el RUC de Alupar en la matriz oficial, marcando el resultado (validado, no coincide, no encontrado) sin bloquear el procesamiento. El cruce considera el IGV (18%): las liquidaciones COES reportan montos sin IGV, por lo que el sistema descuenta el impuesto del monto facturado antes de comparar, evitando falsos descuadres.
  - Busca en la tabla de referencias para identificar la empresa remitente a partir del RUC extraído o del dominio del correo.
  - Asigna departamento responsable basándose en el tipo de documento y empresa origen.
  - Genera sugerencias de derivación que se presentan en el panel web.

> **Nota sobre Google Document AI:** el sistema incluye soporte opcional para Document AI de Google Cloud (configurable mediante variable de entorno `USE_DOCUMENT_AI`), como integración puntual cross-cloud independiente del resto de la infraestructura (que corre en Azure). Dado que el flujo principal trabaja con XML estructurado en formato SUNAT, esta integración no es necesaria para el caso de uso central y no genera costo operativo si no se activa. Puede activarse en el futuro si se requiere extraer datos de PDFs escaneados sin capa de texto.

- **Azure Blob Storage:**

  - Almacena los documentos adjuntos (PDF, XML, imágenes) y los excels mensuales de COES en almacenamiento en la nube para acceso futuro sin depender de que el correo original esté disponible.
  - El panel permite exportar la selección de facturas a un archivo Excel (.xlsx) directamente desde el navegador, útil como respaldo o para análisis posterior.
  - También permite generar un **ZIP consolidado** con los documentos de las facturas seleccionadas, organizados por empresa, con una ventana de selección que deja elegir qué archivos de cada factura incluir en la descarga.
- **Azure Container Apps (panel web de usuario final):**

  - Un panel web accesible desde navegador que muestra el resumen de facturas: tabla con empresa, remitente, fecha, tipo, estado, monto con IGV y monto sin IGV (si está extraído).
  - Funcionalidades: ordenar por columnas, filtrar por empresa/departamento/fecha, ver detalles de cada documento (incluida la previsualización del correo original), cambiar clasificación manual si es necesario, marcar como "derivado", agregar notas.
  - Vista dedicada para COES: resumen de las contrapartes de Alupar (cobra/paga), gráfico comparativo de montos, histórico por empresa al hacer clic y verificador manual de cruce por RUC y periodo (mostrando el monto con y sin IGV).
  - **Vista de facturas fallidas:** los documentos que no se pudieron procesar automáticamente no se pierden; se listan en una vista aparte mostrando el remitente, la hora del correo, el mensaje de error y una previsualización del cuerpo del correo. Desde ahí se pueden "llenar los datos manualmente" para completar la información faltante y enviar el registro al flujo normal del dashboard.
  - El panel se actualiza en tiempo real conforme llegan nuevos correos a Workato (vía WebSocket), y el acceso está protegido con inicio de sesión corporativo (Microsoft Entra ID).

#### Integración y flujo de datos

El flujo completo funciona así:

1. Un correo con factura llega a Outlook.
2. Workato lo detecta en los próximos 5 minutos.
3. Extrae datos preliminares (remitente, fecha, asunto) y envía los archivos adjuntos (XML, PDF, ZIP) codificados hacia Microsoft Azure.
4. El backend en Azure recibe los archivos y determina su tipo:
   - Si es **ZIP** (formato típico de efacturacion.pe y portales SUNAT), lo descomprime y procesa los XML y PDF internos.
   - Si es **XML UBL 2.1** (comprobante electrónico SUNAT), extrae directamente: RUC, emisor, número, fecha, monto, moneda, tipo de documento, concepto y receptor. No se necesita ningún servicio externo de reconocimiento de texto.
   - Si es **PDF**, se extrae texto directamente del archivo digital (para PDFs con texto seleccionable).
5. Con el RUC, número de comprobante, serie y fecha extraídos, se consulta en tiempo real el **portal libre de SUNAT** para validar: estado del comprobante (ACEPTADO / ANULADO / NO EXISTE), estado del contribuyente y condición de domicilio.
6. Si el concepto corresponde a Peajes o a una transferencia COES (VTEA/VTP), se contrasta el monto facturado contra la liquidación mensual oficial de COES, descargada y actualizada automáticamente.
7. El backend busca en la tabla de referencias para identificar empresa y departamento (usando el RUC extraído o el dominio del correo).
8. Almacena el registro completo en Cosmos DB: datos extraídos, validación SUNAT, validación COES, clasificación y metadata del correo.
9. Guarda el adjunto original en Azure Blob Storage.
10. El panel web refleja la nueva factura con toda la información compilada, incluyendo las validaciones SUNAT y COES.
11. El usuario responsable ve el resumen, valida la clasificación (o la ajusta), y marca como "listo para derivar".

> **Resiliencia ante fallos:** si la extracción automática de un documento falla (XML mal formado, PDF sin texto, etc.), el correo y sus adjuntos se almacenan igualmente con estado de error en lugar de descartarse. Esos casos aparecen en la vista de facturas fallidas, donde el usuario puede revisar el cuerpo del correo y completar los datos manualmente para incorporarlos al flujo normal, garantizando que ningún documento se pierda.

## 4. Beneficios de la solución

### Beneficios operacionales

1. **Reducción de tiempo de procesamiento:** de un promedio de 3-5 minutos por factura (búsqueda, lectura, clasificación manual) a menos de 1 minuto (revisión y confirmación en el panel).
2. **Precisión mejorada:** la clasificación automática elimina errores de transcripción manual. El usuario únicamente valida y corrige, lo que es más rápido y menos propenso a error que hacer la clasificación desde cero.
3. **Visibilidad centralizada:** toda factura pendiente está en un único lugar, ordenada y clasificada. No hay riesgo de que se pierda un correo en la bandeja de entrada.
4. **Trazabilidad completa:** se registra quién procesó cada factura, cuándo, y a qué departamento se derivó. Esto facilita auditoría y seguimiento de discrepancias.
5. **Escalabilidad sin costo proporcional:** si el volumen de facturas aumenta, el sistema absorbe el crecimiento sin que requiera más horas de trabajo de la persona responsable. La infraestructura en la nube escala automáticamente.

## 5. Alcance del proyecto

### Incluye

1. **Levantamiento funcional inicial:** reunión con el equipo para detallar el flujo actual, listar empresas proveedoras, documentar reglas de clasificación y departamentos responsables.
2. **Configuración de Workato:**
   - Conexión segura con Outlook corporativo.
   - Definición de filtros para captura de facturas (palabras clave, tipos de adjuntos).
   - Extracción automática de datos preliminares (remitente, asunto, fecha, nombres de archivos).
   - Validación de filtros con ejemplos reales del correo histórico.
3. **Implementación en Microsoft Azure:**
   - Base de datos (Azure Cosmos DB) para almacenar registro de facturas y referencias de empresas.
   - **Extracción nativa de campos desde XML UBL 2.1** (formato estándar SUNAT): RUC, emisor, receptor, número de comprobante, fecha de emisión y vencimiento, monto, moneda y tipo de documento.
   - **Soporte para archivos ZIP** (formato de portales como efacturacion.pe): descompresión automática y procesamiento de los XML y PDF contenidos.
   - **Validación de comprobantes contra el portal libre de SUNAT**: estado del comprobante (ACEPTADO / ANULADO / NO EXISTE), estado del contribuyente (ACTIVO / BAJA), condición de domicilio (HABIDO / NO HABIDO).
   - **Prevalidación de montos COES** (Peajes, VTEA, VTP): descarga mensual automática de liquidaciones oficiales y cruce de montos por RUC.
   - Lógica de clasificación automática (búsqueda de empresa por RUC extraído o dominio de correo).
   - Almacenamiento seguro de documentos adjuntos en Azure Blob Storage.
   - Inicio de sesión corporativo con Microsoft Entra ID.
   - Integración con Workato para recibir archivos binarios y procesarlos en tiempo real.
4. **Desarrollo del panel web de usuario:**
   - Tabla de facturas con información compilada: empresa, remitente, fecha, tipo, monto con IGV, monto sin IGV, estado.
   - Funcionalidades: filtros por empresa/departamento/fecha, búsqueda, ordenamiento.
   - Capacidad de editar clasificación manualmente y registrar cambios.
   - Botón para marcar como "derivado" y registrar hacia qué equipo.
   - Vista de detalles para ver correo original, adjuntos, datos extraídos.
   - Exportación a Excel (.xlsx) y a ZIP consolidado con selección de archivos por factura.
   - Vista de facturas fallidas con previsualización del correo y llenado manual de datos.
   - Vista COES con histórico por empresa y verificador manual de montos por RUC (con y sin IGV).
5. **Base de referencias inicial:**
   - Mapeo de dominios de correo a empresas.
   - Asignación de departamentos responsables por tipo de documento (factura o comprobante) y empresa.
6. **Pruebas funcionales:**
   - Captura de correos históricos (simulación de escucha sobre correos pasados).
   - Validación de clasificaciones automáticas.
   - Pruebas de usabilidad del panel con el equipo.
   - Ajustes de reglas y referencias.
7. **Documentación y capacitación:**
   - Guía de uso del panel web.
   - Procedimiento para actualizar referencias de empresas (agregar nuevos proveedores, cambiar departamentos).
   - Manual de solución de problemas.
   - Sesión de capacitación inicial (1-2 horas) con el equipo responsable.
8. **Período de soporte inicial:** 5 días calendario posteriores a la entrega para ajustes, respuesta a preguntas y resolución de incidencias.

### No incluye en esta propuesta

1. Integración con sistemas de contabilidad o ERP (SAP, NetSuite, Xero, etc.). Si se requiere en fases posteriores, se cotizará por separado.
2. Extracción de datos mediante OCR desde imágenes escaneadas (documentos en papel fotografiados o escaneados sin capa de texto). La solución trabaja con documentos en formato digital estándar: XML UBL (comprobantes electrónicos SUNAT) y PDF con texto seleccionable. Si en una fase posterior se requiere procesar imágenes escaneadas, puede activarse Google Document AI como módulo opcional.
3. Modificación de la infraestructura de Outlook (creación de buzones compartidos, reglas de filtro a nivel de servidor, etc.). Se asume acceso a Outlook convencional del usuario final.
4. Procesamiento de facturas en idiomas distintos al español. Las reglas se acotarán a documentos en español e inglés.
5. Interfaz móvil. El panel web es responsivo y funciona en celulares, pero no se desarrollará una aplicación mobile nativa dedicada.
6. Integración con WhatsApp, Telegram o canales de comunicación distintos a correo. La solución se limita a monitoreo de Outlook.

## 6. Metodología de trabajo

El proyecto se desarrolla en 6 etapas iterativas con puntos de validación que aseguran que la solución refleje fielmente lo que el equipo requiere.

### Etapa 1 — Levantamiento detallado y mapeo de referencias

Se realizan sesiones con el equipo para comprender en detalle:

- Quiénes son los principales proveedores y clientes que envían facturas.
- Cómo se identifican (dominios de correo, datos disponibles en el correo y documentos adjuntos).
- Qué departamentos son responsables de cada tipo de documento.
- Qué datos son considerados "críticos" para tomar una decisión (empresa, monto, fecha, tipo).
- Casos especiales o excepciones al flujo general.

Se genera una tabla de referencias inicial con dominios de empresas, códigos, y asignaciones de departamento que será la base de la clasificación automática.

**Resultado esperado:** documento con flujo actual validado, tabla de referencias inicial, lista de casos especiales.

### Etapa 2 — Configuración de Workato y validación de captura

Se configura Workato para monitorear Outlook y se define el conjunto de filtros que determinan si un correo contiene factura. Se hacen pruebas con correos históricos para validated que se capturen todos los documentos relevantes sin un exceso de falsos positivos.

Se documenta la taxonomía de datos que Workato extrae en cada correo (remitente, asunto, fecha, adjuntos) para confirmar que toda la información necesaria está disponible.

**Resultado esperado:** Workato configurado y validado capturando facturas de Outlook con precisión.

### Etapa 3 — Implementación de base de datos y lógica de clasificación

Se crea la base de datos en Microsoft Azure (Cosmos DB) donde se almacenarán registros de facturas y referencias de empresas. Se implementa la lógica de clasificación: búsqueda de empresa por dominio de correo y datos disponibles del correo, asignación automática de departamento.

Se prueban las reglas con ejemplos reales del correo histórico para validar que la clasificación es correcta en la gran mayoría de casos. Los casos ambiguos se marcan para revisión manual.

**Resultado esperado:** base de datos funcional con reglas de clasificación probadas contra datos históricos reales.

### Etapa 4 — Desarrollo del panel web

Se crea una interfaz web donde el usuario accede a la tabla de facturas capturadas. Se implementan funcionalidades de filtrado, búsqueda, vista de detalles y edición de clasificación. Se asegura que la interfaz sea clara e intuitiva para usuarios no técnicos.

Se realiza pruebas de rendimiento para verificar que el panel carga rápidamente incluso con cientos de facturas históricas.

**Resultado esperado:** panel web funcional, intuitivo y validado con el equipo usuario final.

### Etapa 5 — Integración de extremo a extremo

Se conectan todos los componentes: Workato envía datos a Microsoft Azure, Azure llena la base de datos y procesa clasificaciones, el panel web consume esos datos en tiempo real. Se realizan pruebas de flujo completo con correos nuevos capturados en vivo.

Se valida que los cambios que el usuario hacer en el panel (reclasificaciones, marcas de derivación) se registren en la base de datos de forma permanente.

**Resultado esperado:** flujo completo de extremo a extremo validado con datos y decisiones reales.

### Etapa 6 — Pruebas finales, capacitación y entrega

Se realizan pruebas con volumen real de correos, se ajustan reglas según hallazgos, se documenta el sistema y se realiza sesión de capacitación con el equipo. Se entrega acceso a los sistemas con credenciales seguras.

Se da soporte inicial durante 5 días calendario para responder preguntas, resolver incidencias menores y hacer ajustes de configuración.

**Resultado esperado:** sistema operativo, equipo capacitado, soporte inicial cubierto.

## 7. Estimación de esfuerzo y cronograma

| Etapa           | Descripción                                               |              Horas | Semana              |
| --------------- | ---------------------------------------------------------- | -----------------: | ------------------- |
| 1               | Levantamiento y mapeo de referencias                       |                  4 | Semana 1            |
| 2               | Configuración de Workato                                  |                  5 | Semana 1-2          |
| 3               | Base de datos, extracción XML y lógica de clasificación |                  8 | Semana 2-3          |
| 3b              | Integración con SUNAT (validación de comprobantes)       |                  5 | Semana 2-3          |
| 4               | Desarrollo del panel web                                   |                  7 | Semana 2-3          |
| 5               | Integración de extremo a extremo                          |                  4 | Semana 3            |
| 6               | Pruebas finales y capacitación                            |                  2 | Semana 4            |
| **Total** |                                                            | **34 horas** | **4 semanas** |

**Costo total:** 34 horas × USD 50/hora = **USD 1,700**

## 8. Inversión y términos

### Costo

- **Tarifa:** USD 50 por hora
- **Horas estimadas:** 34 horas
- **Inversión total:** USD 1,700

### Infraestructura en la nube (Microsoft Azure)

La infraestructura en Microsoft Azure requerida para operar el sistema (Container Apps, Cosmos DB, Blob Storage, Microsoft Entra ID) tiene un costo estimado de **USD 12-55 por mes** para un volumen de referencia de 200 facturas mensuales, según el escenario de uso: desde USD 12/mes en el mejor caso (autoescalado a cero fuera de horas de uso) hasta USD 55/mes en el peor caso (aplicación siempre activa con autoescalado por picos sostenidos); el escenario de operación normal se ubica alrededor de USD 30/mes. Al procesar documentos XML de forma nativa sin servicios de visión artificial o machine learning, el costo operativo se reduce significativamente respecto a arquitecturas que dependen de Document AI o Vision API. Una comparativa de este mismo estimado contra Google Cloud está disponible en el cuadro de costos del proyecto.

Se propone completar el desarrollo, pruebas y entrega en esta propuesta. Los costos operativos mensuales de infraestructura serán responsabilidad del cliente (facturable directamente por Microsoft Azure). La validación de comprobantes contra SUNAT y la descarga de liquidaciones COES utilizan portales públicos y no generan costo adicional.

### Términos de pago

Se propone un esquema de pagos por hito:

- 30% a la firma de este documento (inicio de Etapa 1).
- 40% al término de Etapa 3 (base de datos y lógica funcional).
- 30% restante a la entrega final (Etapa 6).

### Alcance de cambios

El presente presupuesto cubre el alcance definido en la Sección 5. Cambios de alcance, adiciones de funcionalidades o integraciones adicionales se documentarán y cotizarán por separado.

## 9. Riesgos y mitigación

### Riesgo 1: Volumen inesperado de correos con falsos positivos

**Descripción:** Si los filtros de Workato son demasiado amplios, pueden capturar correos que no contienen facturas (por ejemplo, confirmaciones de recepción, correos de cotización, etc.), generando ruido en el panel.

**Mitigación:** En la Etapa 2 se prueban los filtros contra histórico real de correos. Se ajusta la sensibilidad basándose en esos resultados. Se incluye opción de "marcar como no factura" en el panel para entrenar el sistema.

### Riesgo 2: Empresas no identificadas por dominio

**Descripción:** Si un proveedor usa múltiples dominios de correo o un dominio genérico, el sistema podría fallar al identificar automáticamente a la empresa origen.

**Mitigación:** La arquitectura está diseñada para tolerar clasificaciones incompletas. Los casos donde no se identifica la empresa automáticamente se marcan como "requiere revisión manual" en el panel. El usuario puede ajustar la clasificación en segundos. Además, se documenta un procedimiento para agregar nuevos dominios a la base de referencias.

### Riesgo 3: Cambios en el formato de Outlook o API

**Descripción:** Microsoft podría cambiar la estructura de Outlook o limitar el acceso vía APIs en una actualización.

**Mitigación:** Workato mantiene sus conectores actualizados como parte de su servicio. Cualquier cambio de Microsoft se comunica de antemano y Workato se adapta. Esta es una ventaja de usar un intermediario especializado en lugar de integración directa.

### Riesgo 4: Documentos con estructura muy variable

**Descripción:** Si las facturas no siguen formatos estandarizados (tamaños diferentes, posición de datos variable, información en distintas páginas), la extracción automática de datos podría ser inconsistente.

**Mitigación:** El sistema prioriza el parseo de XML UBL 2.1, que es un formato estructurado y normado por SUNAT. Esto elimina la variabilidad de diseño presente en documentos visuales. Para PDFs con texto seleccionable, se aplica extracción directa del contenido digital. Los casos donde no se extraiga automáticamente algún campo se marcan para revisión manual en el panel.

### Riesgo 5: Disponibilidad del portal de consultas de SUNAT

**Descripción:** El portal libre de SUNAT (`consultaUnificadaLibre`) puede estar temporalmente no disponible por mantenimiento o cambios en su estructura.

**Mitigación:** La validación SUNAT es un paso complementario: si el portal no está disponible, el documento se registra igualmente con el campo de validación en estado pendiente. El sistema reintenta la validación de forma automática en el siguiente ciclo. Cualquier cambio estructural en la interfaz de SUNAT se atenderá como parte del soporte post-entrega o en mantenimiento programado.

## 10. Próximos pasos

Si esta propuesta es de interés, se sugieren los siguientes pasos:

1. Revisión y validación del documento con los stakeholders internos (jefe de operaciones, equipo de contabilidad, área de TI).
2. Sesión de aclaración (1 hora aproximadamente) para responder preguntas técnicas y ajustar cualquier aspecto de la solución propuesta.
3. Firma de acuerdo con términos de referencia y cronograma.
4. Inicio de Etapa 1: levantamiento detallado y mapeo de referencias.

## 11. Conclusión

Esta propuesta plantea una solución pragmática que automatiza las partes repetitivas del proceso de revisión y clasificación de documentos. El sistema está diseñado para ser robusto frente a variabilidad en el formato de documentos, escalable conforme crezca el volumen de correos, y fácil de mantener y mejorar en etapas posteriores.

La inversión estimada (USD 1,700) se justifica por la reducción de tiempo operativo diario, la mejora en precisión de clasificaciones y la creación de un registro trazable de todas las operaciones realizadas. El retorno de inversión se recupera típicamente en los primeros 2-3 meses de operación.

Estamos disponibles para aclarar cualquier aspecto de esta propuesta y para iniciar el trabajo tan pronto el cliente lo apruebe.
