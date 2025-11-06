/**
 * Generate fake contact data based on the structure of Ran_real_connections.csv
 * Creates ~1k records with realistic data for testing the CSV Filter Sampler agent
 */

import { faker } from "@faker-js/faker";
import Papa from "papaparse";

// Decision-making titles for testing filtering (from real Ran_real_connections.csv)
const DECISION_TITLES = [
  "CEO",
  "Chief Executive Officer",
  "CFO",
  "Chief Financial Officer",
  "CTO",
  "Chief Technology Officer",
  "CMO",
  "Chief Marketing Officer",
  "COO",
  "Chief Operating Officer",
  "President",
  "VP / Head of BD & Brand Partnerships",
  "VP, Label Management",
  "SVP, Music Services",
  "Senior Vice President",
  "Director, Sales and Marketing",
  "Director Of Business Development",
  "Editorial Director",
  "Founder",
  "Co-Founder",
  "Co-founder/CEO",
  "CEO & Co-Founder",
  "CEO/Founder",
  "Founder \\ CEO",
  "Owner",
];

// Non-decision titles for testing filtering accuracy (from real Ran_real_connections.csv)
const NON_DECISION_TITLES = [
  "Manager, Business Intelligence - Customer Packaging Experience (CPEX)",
  "Sr. Producer",
  "Strategy & Operations",
  "Digital Marketing & Growth Manager",
  "Global Programs Producer + Creative Operations, Apple Music",
  "Production Designer",
  "Accounting Manager / Onboarding Manager",
  "Account Manager",
  "Account Executive - Expansion",
  "Analyst",
  "Business Analyst",
  "Marketing Manager",
  "Senior Manager, Accounting",
];

const DEPARTMENTS = [
  "C-Suite",
  "Sales",
  "Marketing",
  "Engineering & Technical",
  "Operations",
  "Finance",
  "Design",
  "Information Technology",
];

// Countries for testing (real CSV has only USA and England, but keeping more options for test variety)
const COUNTRIES = [
  "USA",
  "England",
  "Canada",
  "Germany",
  "France",
  "Japan",
  "Australia",
  "Singapore",
];

// Industries from real Ran_real_connections.csv
const INDUSTRIES = [
  "Music",
  "Internet",
  "Computer Software",
  "Venture Capital & Private Equity",
  "Biotechnology",
  "Consumer Electronics",
  "Financial Services",
  "Medical Devices",
  "Real Estate",
  "Marketing and Advertising",
  "Entertainment",
  "Media Production",
  "Online Media",
  "Broadcast Media",
  "Computer Games",
];

function generateContact(isUSA: boolean, isDecisionMaker: boolean) {
  const country = isUSA ? "USA" : faker.helpers.arrayElement(COUNTRIES.filter((c) => c !== "USA"));
  const title = isDecisionMaker
    ? faker.helpers.arrayElement(DECISION_TITLES)
    : faker.helpers.arrayElement(NON_DECISION_TITLES);

  // Determine seniority based on title
  let seniority: string;
  if (
    title.includes("CEO") ||
    title.includes("CFO") ||
    title.includes("CTO") ||
    title.includes("COO") ||
    title.includes("CMO") ||
    title.includes("Chief")
  ) {
    seniority = "C suite";
  } else if (title.includes("VP") || title.includes("Vice President")) {
    seniority = "Vp";
  } else if (title.includes("Director")) {
    seniority = "Director";
  } else if (title.includes("Senior") || title.includes("Sr.")) {
    seniority = "Senior";
  } else if (title.includes("Manager")) {
    seniority = "Manager";
  } else if (title.includes("Founder") || title.includes("Owner")) {
    seniority = "Founder";
  } else {
    seniority = "Entry";
  }

  const companyName = faker.company.name();
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${companyName.toLowerCase().replace(/[^a-z]/g, "")}.com`;

  const state = country === "USA" ? faker.location.state() : "";
  const city = faker.location.city();
  const companyLocation =
    country === "USA" ? `${city}, ${state}, United States` : `${city}, ${faker.location.country()}`;
  const location =
    country === "USA"
      ? `${faker.location.city()}, ${faker.location.state()}, United States`
      : companyLocation;

  return {
    Qualification: "p",
    firstName,
    lastName,
    companyName,
    title,
    regularCompanyUrl: `https://www.linkedin.com/company/${faker.number.int({ min: 1000, max: 9999999 })}`,
    Email: email,
    Seniority: seniority,
    Departments: faker.helpers.arrayElement(DEPARTMENTS),
    "Corporate Phone":
      faker.helpers.maybe(() => faker.phone.number(), { probability: 0.7 }) || "#ERROR!",
    "# Employees": faker.number.int({ min: 1, max: 10000 }),
    profileUrl: `http://www.linkedin.com/in/${firstName.toLowerCase()}${lastName.toLowerCase()}`,
    "Company Linkedin Url": `http://www.linkedin.com/company/${companyName.toLowerCase().replace(/[^a-z]/g, "")}`,
    "Annual Revenue":
      faker.helpers.maybe(() => faker.number.int({ min: 100000, max: 500000000 }), {
        probability: 0.6,
      }) || "",
    "Number of Retail Locations":
      faker.helpers.maybe(() => faker.number.int({ min: 1, max: 100 }), { probability: 0.3 }) || "",
    industry: faker.helpers.arrayElement(INDUSTRIES),
    companyLocation,
    location,
    Country: country,
    profileImageUrl: faker.helpers.maybe(() => faker.image.avatar(), { probability: 0.8 }) || "",
    isPremium: faker.helpers.arrayElement(["TRUE", "FALSE"]),
  };
}

export async function generateFakeCSV(
  outputPath: string,
  totalRecords = 1000,
  usaPercentage = 0.35,
  decisionMakerPercentage = 0.25,
): Promise<void> {
  const records: ReturnType<typeof generateContact>[] = [];

  // Calculate how many of each type to generate
  const usaCount = Math.floor(totalRecords * usaPercentage);
  const decisionMakerCount = Math.floor(totalRecords * decisionMakerPercentage);

  // Generate USA decision makers
  const usaDecisionMakers = Math.floor(usaCount * decisionMakerPercentage);
  for (let i = 0; i < usaDecisionMakers; i++) {
    records.push(generateContact(true, true));
  }

  // Generate USA non-decision makers
  const usaNonDecisionMakers = usaCount - usaDecisionMakers;
  for (let i = 0; i < usaNonDecisionMakers; i++) {
    records.push(generateContact(true, false));
  }

  // Generate non-USA decision makers
  const nonUsaDecisionMakers = decisionMakerCount - usaDecisionMakers;
  for (let i = 0; i < nonUsaDecisionMakers; i++) {
    records.push(generateContact(false, true));
  }

  // Generate non-USA non-decision makers
  const nonUsaNonDecisionMakers = totalRecords - usaCount - nonUsaDecisionMakers;
  for (let i = 0; i < nonUsaNonDecisionMakers; i++) {
    records.push(generateContact(false, false));
  }

  // Shuffle records (Fisher-Yates algorithm)
  for (let i = records.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = records[i];
    if (temp && records[j]) {
      records[i] = records[j];
      records[j] = temp;
    }
  }

  // Convert to CSV
  const csv = Papa.unparse(records);
  await Deno.writeTextFile(outputPath, csv);

  console.log(`Generated ${totalRecords} fake contact records at ${outputPath}`);
  console.log(`- USA contacts: ${usaCount} (${(usaPercentage * 100).toFixed(1)}%)`);
  console.log(
    `- Decision makers: ${decisionMakerCount} (${(decisionMakerPercentage * 100).toFixed(1)}%)`,
  );
  console.log(`- USA decision makers (target for filtering): ${usaDecisionMakers}`);
}
