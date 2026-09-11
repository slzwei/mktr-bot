import { randomUUID } from "node:crypto";
import type { Contact } from "../src/lib/domain.js";
import { HttpError } from "./http-error.js";
import type { Store } from "./store.js";

/** Singapore local numbers may omit +65; international numbers must carry + or 00. */
export function normalizePhone(input: string): string {
  const value = input.trim();
  if (!value || !/^[+\d\s().-]+$/.test(value)) throw new HttpError(400, "Phone contains unsupported characters or an extension.");
  let phone = value.replace(/[\s().-]/g, "");
  if (/^[3689]\d{7}$/.test(phone)) phone = `+65${phone}`;
  else if (/^65[3689]\d{7}$/.test(phone)) phone = `+${phone}`;
  else if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new HttpError(400, "Phone must be a Singapore number or an international E.164 number.");
  if (phone.startsWith("+65") && !/^\+65[3689]\d{7}$/.test(phone)) throw new HttpError(400, "Singapore phone numbers require eight digits starting with 3, 6, 8, or 9.");
  return phone;
}

function parseCsv(csv: string): string[][] {
  if (Buffer.byteLength(csv, "utf8") > 1_000_000) throw new HttpError(413, "CSV is limited to 1 MB.");
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closedQuote = false;
  const text = csv.replace(/^\uFEFF/, "");
  const endField = () => { row.push(field); field = ""; closedQuote = false; };
  const endRow = () => {
    endField();
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
    if (rows.length > 1001) throw new HttpError(400, "Import at most 1,000 contacts at a time.");
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; closedQuote = true; }
      } else field += char;
      continue;
    }
    if (char === ",") endField();
    else if (char === "\n" || char === "\r") { endRow(); if (char === "\r" && text[index + 1] === "\n") index++; }
    else if (char === '"' && field.length === 0 && !closedQuote) quoted = true;
    else if (char === '"' || closedQuote) throw new HttpError(400, `Malformed CSV near row ${rows.length + 1}.`);
    else field += char;
  }
  if (quoted) throw new HttpError(400, "CSV has an unterminated quoted field.");
  if (field || row.length || closedQuote) endRow();
  return rows;
}

export function previewContacts(store: Store, csv: string) {
  const [headers, ...rows] = parseCsv(csv);
  if (!headers || !rows.length) throw new HttpError(400, "CSV needs a phone header and at least one contact.");
  const normalizedHeaders = headers.map((header) => header.trim().toLowerCase());
  if (!normalizedHeaders.includes("phone") || normalizedHeaders.some((header) => !["name", "phone"].includes(header)) || new Set(normalizedHeaders).size !== normalizedHeaders.length) throw new HttpError(400, "CSV headers must be phone and optional name, without duplicates.");
  const phoneIndex = normalizedHeaders.indexOf("phone"), nameIndex = normalizedHeaders.indexOf("name");
  const unique = new Map<string, { name: string; phone: string }>();
  let duplicates = 0;
  rows.forEach((row, index) => {
    if (row.length !== headers.length) throw new HttpError(400, `CSV row ${index + 2} does not match the header columns.`);
    let phone: string;
    try { phone = normalizePhone(row[phoneIndex]); }
    catch (error) { throw new HttpError(400, `CSV row ${index + 2}: ${error instanceof Error ? error.message : "Invalid phone."}`); }
    const name = nameIndex < 0 ? "" : row[nameIndex].trim();
    if (name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, `CSV row ${index + 2}: name must be at most 120 characters without control characters.`);
    if (unique.has(phone) || store.findContactByPhone(phone)) { duplicates++; return; }
    unique.set(phone, { name, phone });
  });
  return { imported: unique.size, duplicates, contacts: [...unique.values()] };
}

export async function importContacts(store: Store, csv: string, date = new Date()) {
  const preview = previewContacts(store, csv);
  // Validate the entire input before writing; one bad row cannot partially import a campaign.
  const timestamp = date.toISOString();
  const contacts: Contact[] = preview.contacts.map((contact) => ({ ...contact, id: randomUUID(), createdAt: timestamp, updatedAt: timestamp }));
  if (contacts.length) store.saveContacts(contacts);
  await store.flush();
  return { imported: contacts.length, duplicates: preview.duplicates, contacts };
}
