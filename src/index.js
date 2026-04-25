import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const envPath = path.join(rootDir, ".env");
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(rootDir, "data");
const statePath = path.join(dataDir, "state.json");

const CITIES = [
  {
    key: "san-martin-de-los-andes",
    name: "San Martin de los Andes",
    latitude: -40.1579,
    longitude: -71.3534
  },
  {
    key: "bariloche",
    name: "Bariloche",
    latitude: -41.1335,
    longitude: -71.3103
  }
];

const WEATHER_API_SNOW_CODES = new Set([
  1066, 1069, 1114, 1117, 1210, 1213, 1216, 1219, 1222, 1225, 1237, 1255, 1258, 1261, 1264, 1279, 1282
]);
const WEATHER_API_MAX_RETRIES = 3;
const WEATHER_API_RETRY_DELAYS_MS = [2000, 5000, 10000];

async function main() {
  const env = await loadEnv(envPath);
  validateEnv(env);

  const intervalMinutes = getPositiveInt(env.CHECK_INTERVAL_MINUTES, 15);
  const runOnce = process.argv.includes("--once");
  const forceMessage = process.argv.includes("--force-message");
  const testMessage = process.argv.includes("--test-message");

  if (testMessage) {
    await sendTelegramMessage(env, buildTestTelegramMessage());
    console.log("[snow-bot] Mensaje de prueba enviado por Telegram");
    return;
  }

  if (runOnce) {
    await checkCities(env, { forceMessage });
    return;
  }

  console.log(
    `[snow-bot] Monitoreando nieve cada ${intervalMinutes} minutos en ${CITIES.map((city) => city.name).join(", ")}`
  );

  await checkCities(env, { forceMessage });

  setInterval(async () => {
    try {
      await checkCities(env, { forceMessage });
    } catch (error) {
      console.error("[snow-bot] Error en chequeo programado:", error.message);
    }
  }, intervalMinutes * 60 * 1000);
}

async function checkCities(env, options = {}) {
  const state = await readState();
  const forceMessage = Boolean(options.forceMessage);

  for (const city of CITIES) {
    try {
      const weather = await fetchCurrentWeatherForCity(city, env.WEATHER_API_KEY);
      const wasSnowing = Boolean(state[city.key]?.isSnowing);
      const isSnowing = detectSnow(weather);

      logWeather(city, weather, isSnowing);

      if ((isSnowing && !wasSnowing) || forceMessage) {
        const message = buildSnowMessage(city, weather);
        await sendTelegramMessage(env, message);
        console.log(`[snow-bot] Aviso enviado por Telegram para ${city.name}`);
      }

      state[city.key] = {
        isSnowing,
        updatedAt: new Date().toISOString(),
        weatherCode: weather.current.condition.code,
        temperature: weather.current.temp_c
      };
    } catch (error) {
      console.error(`[snow-bot] Fallo el procesamiento de ${city.name}:`, error.message);
    }
  }

  await writeState(state);
}

async function fetchCurrentWeatherForCity(city, apiKey) {
  const url = new URL("https://api.weatherapi.com/v1/current.json");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("q", `${city.latitude},${city.longitude}`);
  url.searchParams.set("aqi", "no");

  return fetchWeatherApiJson(url);
}

async function fetchWeatherApiJson(url) {
  for (let attempt = 0; attempt <= WEATHER_API_MAX_RETRIES; attempt += 1) {
    const response = await fetch(url);

    if (response.ok) {
      return response.json();
    }

    if (response.status !== 429 || attempt === WEATHER_API_MAX_RETRIES) {
      const text = await response.text();
      throw new Error(`WeatherAPI devolvio ${response.status}: ${text}`);
    }

    const delayMs = WEATHER_API_RETRY_DELAYS_MS[attempt] ?? 10000;
    console.warn(
      `[snow-bot] WeatherAPI devolvio 429. Reintentando en ${delayMs / 1000} segundos...`
    );
    await sleep(delayMs);
  }
}

function detectSnow(weather) {
  const current = weather.current ?? {};
  const weatherCode = Number(current.condition?.code);
  const conditionText = String(current.condition?.text ?? "").toLowerCase();
  return WEATHER_API_SNOW_CODES.has(weatherCode) || conditionText.includes("snow");
}

function buildSnowMessage(city, weather) {
  const current = weather.current;
  const temperature = escapeTelegramMarkdown(formatNumber(current.temp_c));
  const conditionText = escapeTelegramMarkdown(current.condition?.text ?? "Sin detalle");
  const humidity = escapeTelegramMarkdown(String(current.humidity ?? ""));
  const cityName = escapeTelegramMarkdown(city.name);
  const reportTime = escapeTelegramMarkdown(weather.location?.localtime ?? new Date().toISOString());

  return [
    `❄️ *Nieve detectada en ${cityName}*`,
    "",
    `🌡️ Temperatura: *${temperature} C*`,
    `🌨️ Condicion: *${conditionText}*`,
    `💧 Humedad: *${humidity}%*`,
    `🕒 Hora del reporte: \`${reportTime}\``
  ].join("\n");
}

function logWeather(city, weather, isSnowing) {
  const current = weather.current;
  console.log(
    `[snow-bot] ${city.name}: code=${current.condition?.code}, temp=${current.temp_c}C, condition=${current.condition?.text}, snowing=${isSnowing}`
  );
}

async function sendTelegramMessage(env, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: body,
        parse_mode: "MarkdownV2"
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram devolvio ${response.status}: ${text}`);
  }
}

async function loadEnv(filePath) {
  const runtimeEnv = {
    CHECK_INTERVAL_MINUTES: process.env.CHECK_INTERVAL_MINUTES,
    DATA_DIR: process.env.DATA_DIR,
    WEATHER_API_KEY: process.env.WEATHER_API_KEY,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID
  };

  if (hasRequiredEnv(runtimeEnv)) {
    return runtimeEnv;
  }

  try {
    const content = await fs.readFile(filePath, "utf8");
    const pairs = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        if (separatorIndex === -1) {
          return null;
        }

        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        return [key, value];
      })
      .filter(Boolean);

    return {
      ...Object.fromEntries(pairs),
      ...pickDefined(runtimeEnv)
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "Faltan variables de entorno. En local usa .env; en Render cargalas en Environment."
      );
    }
    throw error;
  }
}

function validateEnv(env) {
  const required = ["WEATHER_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
  const missing = required.filter((key) => !env[key]);

  if (missing.length > 0) {
    throw new Error(`Faltan variables de entorno: ${missing.join(", ")}`);
  }
}

function getPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function hasRequiredEnv(env) {
  return Boolean(env.WEATHER_API_KEY && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

function pickDefined(env) {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readState() {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}

function formatNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toFixed(1) : "0.0";
}

function escapeTelegramMarkdown(value) {
  return String(value ?? "").replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

function buildTestTelegramMessage() {
  const reportTime = escapeTelegramMarkdown(new Date().toISOString());

  return [
    "🧪 *Mensaje de prueba de SnowBot*",
    "",
    "✅ Telegram quedo configurado correctamente",
    `🕒 Hora: \`${reportTime}\``
  ].join("\n");
}

main().catch((error) => {
  console.error("[snow-bot]", error.message);
  process.exitCode = 1;
});
