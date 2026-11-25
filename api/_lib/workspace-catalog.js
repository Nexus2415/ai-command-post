// Plugin catalog (2026-11-25): ready-made look-up tools the owner can add with one review and one tap, instead of
// building them on the Tools page. Each entry is an ordinary custom look-up tool ("http" connector): it goes
// through exactly the same checks, plain-language review and confirmation code as one he builds himself
// (workspace-connectors.js), and once added it is metered, gated and switchable like any other.
//
// Only free services that need no key, take a plain GET with ?name=value inputs, and only read. Each address was
// tried by hand on 2026-11-25. New entries need the same: a test in test/workspace-catalog.test.ts checks every
// entry passes the builder's checks.

export const CATALOG = Object.freeze([
  {
    id: "weather", category: "Everyday", title: "Weather forecast",
    blurb: "Current weather and the next 3 days for any place, from Open-Meteo. Free, no key.",
    spec: {
      name: "weather", url: "https://api.open-meteo.com/v1/forecast?current=temperature_2m,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=3&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph",
      description: "Weather now and the forecast for the next 3 days at a latitude and longitude. Look up the coordinates of a place first if you need them.",
      returns: "JSON with current temperature (F), rain, wind (mph) and daily highs, lows and chance of rain",
      inputs: [
        { name: "latitude", type: "number", required: true, description: "Latitude, for example 38.9 for Washington DC" },
        { name: "longitude", type: "number", required: true, description: "Longitude, for example -77.0 for Washington DC" },
      ],
    },
  },
  {
    id: "fxrates", category: "Business", title: "Currency exchange rates",
    blurb: "Today's official exchange rates (European Central Bank), from Frankfurter. Free, no key.",
    spec: {
      name: "fxrates", url: "https://api.frankfurter.dev/v1/latest",
      description: "Latest official exchange rates published by the European Central Bank, from one currency to others.",
      returns: "JSON with the date and the rate for each currency asked about",
      inputs: [
        { name: "from", type: "string", required: true, description: "Three-letter currency code to convert from, like USD" },
        { name: "to", type: "string", required: false, description: "Currency codes to convert to, comma separated, like EUR,GBP,JPY" },
      ],
    },
  },
  {
    id: "wikipedia", category: "Research", title: "Wikipedia search",
    blurb: "Finds Wikipedia articles and short extracts on any topic. Free, no key.",
    spec: {
      name: "wikipedia", url: "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5",
      description: "Searches English Wikipedia and lists the 5 best-matching articles with a short snippet of each.",
      returns: "JSON with article titles, snippets and word counts",
      inputs: [{ name: "srsearch", type: "string", required: true, description: "What to search for" }],
    },
  },
  {
    id: "hackernews", category: "Research", title: "Hacker News search",
    blurb: "What the tech and startup world is saying about a company, product or idea. Free, no key.",
    spec: {
      name: "hackernews", url: "https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=8",
      description: "Searches Hacker News stories (tech and startup news and discussion) for a company, product or topic.",
      returns: "JSON with story titles, links, points, comment counts and dates",
      inputs: [{ name: "query", type: "string", required: true, description: "Company, product or topic" }],
    },
  },
  {
    id: "githubrepos", category: "Developer", title: "GitHub project search",
    blurb: "Finds public open-source projects on GitHub, with stars and descriptions. Free, no key.",
    spec: {
      name: "githubrepos", url: "https://api.github.com/search/repositories?per_page=8",
      description: "Searches public GitHub repositories by keywords and lists the best matches.",
      returns: "JSON with repository names, descriptions, stars, languages and links",
      inputs: [{ name: "q", type: "string", required: true, description: "Keywords, for example invoice ocr language:python" }],
    },
  },
  {
    id: "npmsearch", category: "Developer", title: "npm package search",
    blurb: "Finds JavaScript packages on npm, with versions and descriptions. Free, no key.",
    spec: {
      name: "npmsearch", url: "https://registry.npmjs.org/-/v1/search?size=8",
      description: "Searches the npm registry of JavaScript packages by keywords.",
      returns: "JSON with package names, versions, descriptions and links",
      inputs: [{ name: "text", type: "string", required: true, description: "Keywords" }],
    },
  },
]);

export const catalogEntry = (id) => CATALOG.find((c) => c.id === id) ?? null;
