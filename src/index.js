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

const SNOW_WEATHER_CODES = new Set([71, 73, 75, 77, 85, 86]);
const OPEN_METEO_MAX_RETRIES = 3;
const OPEN_METEO_RETRY_DELAYS_MS = [2000, 5000, 10000];

async function main() {
  const env = await loadEnv(envPath);
  validateEnv(env);

  const intervalMinutes = getPositiveInt(env.CHECK_INTERVAL_MINUTES, 15);
  const runOnce = process.argv.includes("--once");
  const forceMessage = process.argv.includes("--force-message");

  if (runOnce) {
    await checkCities(env, { forceMessage });
    return;
  }

  console.log(
    `[snow-bot] Monitoreando nieve cada ${intervalMinutes} minutos en ${CITIES.map((city) => city.name).join(", ")}`
  );

  await checkCities(env);

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
  const weatherByCity = await fetchCurrentWeatherForCities(CITIES, env.OPEN_METEO_TIMEZONE);

  for (const city of CITIES) {
    try {
      const weather = weatherByCity[city.key];
      if (!weather) {
        throw new Error("No llegaron datos meteorologicos para la ciudad");
      }
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
        weatherCode: weather.current.weather_code,
        temperature: weather.current.temperature_2m
      };
    } catch (error) {
      console.error(`[snow-bot] Fallo el procesamiento de ${city.name}:`, error.message);
    }
  }

  await writeState(state);
}

async function fetchCurrentWeatherForCities(cities, timezone) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set(
    "latitude",
    cities.map((city) => String(city.latitude)).join(",")
  );
  url.searchParams.set(
    "longitude",
    cities.map((city) => String(city.longitude)).join(",")
  );
  url.searchParams.set("current", "temperature_2m,precipitation,rain,snowfall,weather_code");
  url.searchParams.set(
    "timezone",
    cities.map(() => timezone || "auto").join(",")
  );

  const payload = await fetchOpenMeteoJson(url);
  const responses = Array.isArray(payload) ? payload : [payload];

  return Object.fromEntries(
    cities.map((city, index) => [city.key, responses[index]])
  );
}

async function fetchOpenMeteoJson(url) {
  for (let attempt = 0; attempt <= OPEN_METEO_MAX_RETRIES; attempt += 1) {
    const response = await fetch(url);

    if (response.ok) {
      return response.json();
    }

    if (response.status !== 429 || attempt === OPEN_METEO_MAX_RETRIES) {
      throw new Error(`Open-Meteo devolvio ${response.status}`);
    }

    const delayMs = OPEN_METEO_RETRY_DELAYS_MS[attempt] ?? 10000;
    console.warn(
      `[snow-bot] Open-Meteo devolvio 429. Reintentando en ${delayMs / 1000} segundos...`
    );
    await sleep(delayMs);
  }
}

function detectSnow(weather) {
  const current = weather.current ?? {};
  const snowfall = Number(current.snowfall ?? 0);
  const weatherCode = Number(current.weather_code);
  return snowfall > 0 || SNOW_WEATHER_CODES.has(weatherCode);
}

function buildSnowMessage(city, weather) {
  const current = weather.current;
  const temperature = escapeTelegramMarkdown(formatNumber(current.temperature_2m));
  const snowfall = escapeTelegramMarkdown(formatNumber(current.snowfall));
  const precipitation = escapeTelegramMarkdown(formatNumber(current.precipitation));
  const cityName = escapeTelegramMarkdown(city.name);
  const reportTime = escapeTelegramMarkdown(current.time);

  return [
    `❄️ *Nieve detectada en ${cityName}*`,
    "",
    `🌡️ Temperatura: *${temperature} C*`,
    `🌨️ Nieve actual: *${snowfall} mm*`,
    `💧 Precipitacion actual: *${precipitation} mm*`,
    `🕒 Hora del reporte: \`${reportTime}\``
  ].join("\n");
}

function logWeather(city, weather, isSnowing) {
  const current = weather.current;
  console.log(
    `[snow-bot] ${city.name}: code=${current.weather_code}, temp=${current.temperature_2m}C, snowfall=${current.snowfall}, snowing=${isSnowing}`
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
    OPEN_METEO_TIMEZONE: process.env.OPEN_METEO_TIMEZONE,
    CHECK_INTERVAL_MINUTES: process.env.CHECK_INTERVAL_MINUTES,
    DATA_DIR: process.env.DATA_DIR,
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
  const required = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];

  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Faltan variables en .env: ${missing.join(", ")}`);
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
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
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

main().catch((error) => {
  console.error("[snow-bot]", error.message);
  process.exitCode = 1;
});
