// Seed registry of program apply pages the aggregator watches.
// Users can add custom URLs in settings; everything is fetched client-side
// on a chrome.alarms schedule — no server involved.
export const PROGRAM_SOURCES = [
  { name: "Y Combinator", url: "https://www.ycombinator.com/apply" },
  { name: "Techstars", url: "https://www.techstars.com/accelerators" },
  { name: "500 Global", url: "https://500.co/founders" },
  { name: "Antler", url: "https://www.antler.co/apply" },
  { name: "Entrepreneur First", url: "https://www.joinef.com/apply" },
  { name: "Seedcamp", url: "https://seedcamp.com/" },
  { name: "Neo", url: "https://neo.com/accelerator" },
  { name: "HF0", url: "https://www.hf0.com/" },
  { name: "South Park Commons", url: "https://www.southparkcommons.com/founder-fellowship" },
  { name: "a16z Speedrun", url: "https://a16z.com/games/speedrun/" },
  { name: "LvlUp Ventures", url: "https://www.lvlup.vc/apply/funding-application" },
  { name: "Forge Residency", url: "https://www.forgeresidency.com/apply" }
];
