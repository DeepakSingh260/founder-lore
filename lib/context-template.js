// Default founder_context template.
// Any leaf that is a checkable claim (numbers, revenue, counts) is an object:
//   { "value": ..., "verified": true|false, "updated": "YYYY-MM-DD" }
// Plain strings are prose the LLM may freely rephrase.
export const CONTEXT_TEMPLATE = {
  schema_version: 1,
  company: {
    name: "",
    one_liner: "",
    problem: "",
    solution: "",
    why_now: "",
    why_us: "",
    industry: "",
    category: "",
    stage: "",
    website: "",
    demo_url: "",
    deck_url: ""
  },
  founders: [
    {
      name: "",
      email: "",
      role: "",
      location: "",
      background: "",
      education: "",
      previous_companies: [],
      technical_background: "",
      founder_story: "",
      linkedin: ""
    }
  ],
  market: {
    target_customer: "",
    ideal_customer_profile: "",
    customer_segments: [],
    market_problem: "",
    market_size: "",
    market_trends: "",
    competitors: [],
    alternatives: [],
    competitive_advantage: ""
  },
  product: {
    description: "",
    how_it_works: "",
    key_features: [],
    technology: [],
    integrations: [],
    security: "",
    deployment_model: "",
    current_capabilities: [],
    roadmap: []
  },
  business: {
    business_model: "",
    pricing: "",
    revenue_model: "",
    sales_model: "",
    distribution_model: "",
    sales_cycle: "",
    average_contract_value: ""
  },
  traction: {
    customers: { value: 0, verified: false, updated: "" },
    paying_customers: { value: 0, verified: false, updated: "" },
    revenue: { value: "", verified: false, updated: "" },
    mrr: { value: "", verified: false, updated: "" },
    arr: { value: "", verified: false, updated: "" },
    growth_rate: { value: "", verified: false, updated: "" },
    pilots: { value: 0, verified: false, updated: "" },
    design_partners: [],
    customer_conversations: { value: 0, verified: false, updated: "" },
    waitlist: { value: 0, verified: false, updated: "" },
    users: { value: 0, verified: false, updated: "" },
    key_metrics: [],
    case_studies: []
  },
  fundraising: {
    currently_raising: false,
    round: "",
    target_amount: { value: "", verified: false, updated: "" },
    valuation: { value: "", verified: false, updated: "" },
    amount_raised: { value: "", verified: false, updated: "" },
    investors: [],
    use_of_funds: "",
    previous_rounds: []
  },
  validation: {
    customer_feedback: [],
    customer_pain_points: [],
    why_customers_buy: [],
    why_customers_dont_buy: [],
    objections: [],
    experiments: [],
    lessons_learned: []
  },
  programs: {
    program_goals: ""
  },
  // Application tracker: one entry per program applied to (or planned).
  // Managed from the Applications section in options; the side panel's
  // "Save to history" auto-creates entries. Notes stay private — they are
  // never sent to the LLM.
  applications: [],
  company_facts: {
    founded: "",
    incorporation_status: "",
    incorporation_country: "",
    team_size: { value: 0, verified: false, updated: "" },
    full_time_founders: { value: 0, verified: false, updated: "" },
    employees: { value: 0, verified: false, updated: "" },
    intellectual_property: [],
    patents: []
  },
  links: {
    github: "",
    twitter: "",
    product_hunt: "",
    youtube: []
  },
  answer_history: []
};

// Extension behavior config — separate from founder context so the context
// file stays portable and personal.
export const DEFAULT_PREFS = {
  tone: "direct, concise, human",
  avoid_buzzwords: true,
  avoid_hype: true,
  prefer_specific_numbers: true,
  first_person: true
};
