import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const recipesDir = path.join(repoRoot, "docs", "recipe-collections", "recipes");
const outputPath = path.join(repoRoot, "docs", "recipe-collections", "resources", "recipes.json");
const recipePathPrefix = path.join("docs", "recipe-collections", "recipes") + path.sep;

function stripInlineCode(value) {
  return value.replace(/^`|`$/g, "").trim();
}

function splitList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIsoDurationMinutes(value) {
  const match = value.match(/\bPT(?:(\d+)H)?(?:(\d+)M)?\b/i);
  if (!match) return null;

  const hours = Number.parseInt(match[1] ?? "0", 10);
  const minutes = Number.parseInt(match[2] ?? "0", 10);
  return hours * 60 + minutes;
}

function parseTextDurationMinutes(value) {
  const normalized = value.toLowerCase();
  const hoursMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(?:hr|hrs|hour|hours)\b/);
  const minutesMatch = normalized.match(/(\d+)\s*(?:min|mins|minute|minutes)\b/);

  const hours = hoursMatch ? Number.parseFloat(hoursMatch[1]) : 0;
  const minutes = minutesMatch ? Number.parseInt(minutesMatch[1], 10) : 0;
  const total = Math.round(hours * 60 + minutes);

  return total > 0 ? total : null;
}

function parseTime(value) {
  const isoMatch = value.match(/\((PT[^)]+)\)/i);
  const iso8601 = isoMatch?.[1] ?? null;
  const minutes = parseIsoDurationMinutes(value) ?? parseTextDurationMinutes(value);

  return {
    label: value.replace(/\s*\(PT[^)]+\)\s*/i, "").trim(),
    iso8601,
    minutes,
  };
}

function parseCalories(value) {
  const match = value.match(/(\d[\d,]*)/);
  return match ? Number.parseInt(match[1].replaceAll(",", ""), 10) : null;
}

function parseIngredient(raw) {
  const normalized = raw.trim();
  const delimiter = normalized.includes(" - ") ? " - " : normalized.includes(",") ? "," : null;

  if (!delimiter) {
    return { raw: normalized, name: normalized, quantity: "" };
  }

  const [name, ...quantityParts] = normalized.split(delimiter);

  return {
    raw: normalized,
    name: name.trim(),
    quantity: quantityParts.join(delimiter).trim(),
  };
}

function parseMarkdownLink(raw) {
  const match = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!match) return { title: raw, path: null };

  return {
    title: match[1].trim(),
    path: match[2].trim(),
  };
}

function sectionBounds(lines) {
  const sections = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^##\s+(.+?)\s*$/);
    if (!match) continue;

    const title = match[1].trim();
    const start = index + 1;
    let end = lines.length;

    for (let cursor = start; cursor < lines.length; cursor += 1) {
      if (/^##\s+/.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }

    sections.set(title, lines.slice(start, end));
  }

  return sections;
}

function parseKeyValueBullets(lines) {
  const values = {};

  for (const line of lines) {
    const match = line.match(/^-\s+([^:]+):\s*(.*)$/);
    if (!match) continue;

    values[match[1].trim()] = stripInlineCode(match[2]);
  }

  return values;
}

function parseIngredients(lines) {
  const groups = [];
  let currentGroup = { name: "Ingredients", items: [] };

  for (const line of lines) {
    const groupMatch = line.match(/^###\s+(.+?)\s*$/);
    if (groupMatch) {
      if (currentGroup.items.length > 0) groups.push(currentGroup);
      currentGroup = { name: groupMatch[1].trim(), items: [] };
      continue;
    }

    const itemMatch = line.match(/^-\s+(.+?)\s*$/);
    if (!itemMatch) continue;

    currentGroup.items.push(parseIngredient(itemMatch[1]));
  }

  if (currentGroup.items.length > 0) groups.push(currentGroup);

  return {
    groups,
    flat: groups.flatMap((group) =>
      group.items.map((item) => ({
        ...item,
        group: group.name,
      })),
    ),
  };
}

function parseMethod(lines) {
  const steps = [];
  let currentStep = null;

  for (const line of lines) {
    const stepMatch = line.match(/^###\s+Step\s+(\d+):\s*(.+?)\s*$/i);
    const headingMatch = line.match(/^###\s+(.+?)\s*$/);

    if (stepMatch || headingMatch) {
      if (currentStep) {
        currentStep.body = currentStep.bodyLines.join("\n\n").trim();
        delete currentStep.bodyLines;
        steps.push(currentStep);
      }

      currentStep = {
        number: stepMatch ? Number.parseInt(stepMatch[1], 10) : steps.length + 1,
        title: (stepMatch ? stepMatch[2] : headingMatch[1]).trim(),
        bodyLines: [],
      };
      continue;
    }

    if (!currentStep) {
      if (line.trim() === "") continue;
      currentStep = {
        number: steps.length + 1,
        title: "Method",
        bodyLines: [],
      };
    }

    if (line.trim() !== "") currentStep.bodyLines.push(line.trim());
  }

  if (currentStep) {
    currentStep.body = currentStep.bodyLines.join("\n\n").trim();
    delete currentStep.bodyLines;
    steps.push(currentStep);
  }

  return {
    steps,
    raw: lines.join("\n").trim(),
  };
}

function parseAppearsIn(lines) {
  return lines
    .map((line) => line.match(/^-\s+(.+?)\s*$/)?.[1])
    .filter(Boolean)
    .map(parseMarkdownLink);
}

function parseRecipe(markdown, filePath) {
  if (!filePath.startsWith(recipePathPrefix) || filePath.includes("..")) {
    throw new Error(`Refusing to parse recipe outside allowlisted directory: ${filePath}`);
  }

  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const title =
    lines
      .find((line) => line.startsWith("# "))
      ?.replace(/^#\s+/, "")
      .trim() ?? "";
  const sourcePath =
    lines.find((line) => line.startsWith("Source path:"))?.match(/`([^`]+)`/)?.[1] ?? null;
  const sections = sectionBounds(lines);
  const metadata = parseKeyValueBullets(sections.get("Metadata") ?? []);
  const nutritionRaw = parseKeyValueBullets(sections.get("Nutrition") ?? []);
  const ingredients = parseIngredients(sections.get("Ingredients") ?? []);
  const method = parseMethod(sections.get("Method") ?? []);
  const appearsIn = parseAppearsIn(sections.get("Appears In") ?? []);

  const metadataHeading = lines.findIndex((line) => line === "## Metadata");
  const sourceLine = lines.findIndex((line) => line.startsWith("Source path:"));
  const summary =
    sourceLine >= 0 && metadataHeading > sourceLine
      ? lines
          .slice(sourceLine + 1, metadataHeading)
          .map((line) => line.trim())
          .filter(Boolean)
          .join("\n\n")
      : "";

  const time = metadata.Time ? parseTime(metadata.Time) : null;

  return {
    id: path.basename(filePath, ".md"),
    title,
    filePath,
    sourcePath,
    summary,
    metadata: {
      author: metadata.Author ?? null,
      datePublished: metadata["Date published"] ?? null,
      yield: metadata.Yield ?? null,
      time,
      category: metadata.Category ?? null,
      cuisine: metadata.Cuisine ?? null,
      keywords: metadata.Keywords ? splitList(metadata.Keywords) : [],
      tags: metadata.Tags ? splitList(metadata.Tags) : [],
      image: metadata.Image ?? null,
      video: metadata.Video ?? null,
      raw: metadata,
    },
    nutrition: {
      calories: nutritionRaw.calories ? parseCalories(nutritionRaw.calories) : null,
      raw: nutritionRaw,
    },
    ingredients,
    method,
    appearsIn,
    searchText: [
      title,
      summary,
      metadata.Category,
      metadata.Cuisine,
      metadata.Keywords,
      metadata.Tags,
      ingredients.flat.map((item) => item.raw).join("; "),
      method.raw,
      appearsIn.map((entry) => entry.title).join("; "),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function main() {
  const entries = await readdir(recipesDir, { withFileTypes: true });
  const recipeFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(recipesDir, entry.name))
    .sort();

  const recipes = [];

  for (const absolutePath of recipeFiles) {
    const markdown = await readFile(absolutePath, "utf8");
    const relativePath = path.relative(repoRoot, absolutePath);
    recipes.push(parseRecipe(markdown, relativePath));
  }

  const payload = {
    schemaVersion: 1,
    source: {
      recipesDir: path.relative(repoRoot, recipesDir),
      count: recipes.length,
    },
    recipes,
  };

  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${recipes.length} recipes to ${path.relative(repoRoot, outputPath)}`);
}

await main();
