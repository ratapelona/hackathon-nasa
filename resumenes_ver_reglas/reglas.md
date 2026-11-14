# PROTOCOLO INQUEBRANTABLE DE EJECUCIÓN, ENTREGAS Y DOCUMENTACIÓN
**Orquestador:** Argon | **Constructor (Builder):** Hydrogen

1. **Regla de Micro-Compacción (1 Archivo por Ciclo):**
   - Ningún archivo de código puede superar las **190 líneas**.
   - Purga el historial conversacional entre archivos leyendo únicamente los archivos `.md` dentro de `./versiones_y_errores/`.
2. **Regla de Entrega Obligatoria (`./versiones_y_errores/PHASE_HANDOFFS.md`):**
   - Al terminar cada archivo o sub-fase, es OBLIGATORIO escribir un bloque de entrega con:
     - `### [Fase X] Qué se hizo y entregó:` (Explicación causa-efecto de lo implementado).
     - `### Contratos y Firmas Exportadas:` (Clases, métodos, rutas y tipos exactos).
     - `### Comandos de Verificación Ejecutados:` (Resultado real en terminal).
3. **Regla de Registro Vivo en `./versiones_y_errores/architecture.md`:**
   - Prohibido dejar `architecture.md` desactualizado. Cada vez que se cree o modifique un script, tabla SQLite, colección ChromaDB o endpoint FastAPI, actualiza el árbol de directorios, el diagrama Mermaid, los contratos de módulos y el estado de integración dentro de `./versiones_y_errores/architecture.md`.
4. **Regla de Bitácora de Errores (`./versiones_y_errores/ERROR_LEDGER.md`):**
   - Todo error detectado (SQLite OperationalError, ReadTimeout, Schema Drift, KeyError, colisión de tipos o bug de UI) DEBE registrarse inmediatamente en `./versiones_y_errores/ERROR_LEDGER.md` bajo el formato:
     `- [Fecha/Fase] | [Módulo] | Error Exacto | Causa Lógica (Por qué ocurrió) | Fix Aplicado (Cómo se blindó)`.
5. **Cero Hardcoding:**
   - Rutas resueltas únicamente con `PROJECT_ROOT = Path(__file__).resolve().parent.parent`.
   - Conexiones frontend con `window.location.origin + "/api"`.
   - Dimensiones fluidas (`vw`, `vh`, `rem`, `%`, `ResizeObserver`), cero píxeles fijos en contenedores.
