# Bot de alerta de nieve por Telegram

Este proyecto revisa si esta nevando en:

- San Martin de los Andes
- Bariloche

Cuando detecta que **empieza** a nevar en una ciudad, manda un mensaje de Telegram y evita repetirlo mientras la nevada siga activa.

Ejemplo de alerta:

```text
❄️ Nieve detectada en Bariloche

🌡️ Temperatura: -1.2 C
🌨️ Nieve actual: 0.8 mm
💧 Precipitacion actual: 1.0 mm
🕒 Hora del reporte: 2026-04-25T08:00
```

## Como funciona

1. Consulta el clima actual en WeatherAPI.
2. Revisa la condicion actual y el codigo meteorologico.
3. Si una ciudad pasa de "sin nieve" a "con nieve", envia un mensaje por Telegram.
4. Guarda el ultimo estado en `data/state.json`.

## Requisitos

- Node.js 18 o superior
- Un bot de Telegram
- Una API key de WeatherAPI

## Configuracion

1. Crea tu archivo `.env` a partir de `.env.example`.
2. Completa tus credenciales:

```env
CHECK_INTERVAL_MINUTES=15
DATA_DIR=./data

WEATHER_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_BOT_TOKEN=123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=123456789
```

## Como obtener el `TELEGRAM_CHAT_ID`

1. Crea un bot con `@BotFather` y guarda el token.
2. Mandale un mensaje a tu bot desde la cuenta o grupo donde quieras recibir alertas.
3. Abri esta URL en el navegador, reemplazando el token:

```text
https://api.telegram.org/botTU_TOKEN/getUpdates
```

4. Busca el valor de `chat.id` en la respuesta y usalo en `.env`.

## Ejecutar

Chequeo unico:

```bash
node src/index.js --once
```

Mensaje de prueba a Telegram:

```bash
node src/index.js --test-message
```

Modo continuo:

```bash
node src/index.js
```

## Desplegar en Render

La opcion mas estable para este bot en Render es un **Background Worker** con **persistent disk**, para conservar `state.json` entre reinicios y despliegues.

El repo ya incluye [render.yaml](C:/Users/Ezequiel/Documents/New%20project/render.yaml) con esa configuracion.

### Pasos

1. Sube este proyecto a GitHub.
2. En Render, entra a **New +** > **Blueprint**.
3. Conecta tu repo y selecciona este proyecto.
4. Render va a detectar `render.yaml` y crear el worker `telegram-snow-alert-bot`.
5. Completa las variables secretas:

```env
WEATHER_API_KEY=tu_weather_api_key
TELEGRAM_BOT_TOKEN=tu_token
TELEGRAM_CHAT_ID=tu_chat_id
```

6. Crea el servicio y espera el primer deploy.

### Notas importantes

- El estado se guarda en el disco persistente montado en `/opt/render/project/src/render-data`.
- Si cambias `CHECK_INTERVAL_MINUTES`, Render redeploya el worker con el nuevo intervalo.
- Segun la documentacion oficial de Render, los **background workers** y los **persistent disks** requieren plan pago.

## Ideas para mejorarlo

- Agregar mas ciudades
- Enviar tambien cuando deje de nevar
- Usar pronostico horario para anticipar nieve
- Desplegarlo en un VPS o en Railway/Render para que quede siempre prendido
