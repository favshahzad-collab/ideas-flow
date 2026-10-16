import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../src/lib/password";

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
  }),
});

/*
 * The organisation's departments, created by name.
 *
 * The seed upserts on the name, so it can ADD a department but it can never
 * rename one: correcting a spelling here and re-running against a database
 * that already has the old name leaves both. Rename an existing one from
 * Administration -> Departments instead, which carries its people with it and
 * writes an audit row; this list is only what a fresh database starts with.
 */
const DEPARTMENTS = [
  "Administration",
  "Beauty & Fragrance",
  "Chairman",
  "Corporate Sales",
  "Customer Services",
  "E-Com IT",
  "E-Com Operations",
  "Fabric Sourcing & Procurement",
  "Facility Management",
  "Finance",
  "Folding / Packing",
  "Footwear & Bags",
  "Gents Fabric",
  "Health & Safety",
  "Home Textile",
  "HR Shared Services & Regulatory Compliance",
  "Human Resources",
  "Information Technology",
  "Internal Audit",
  "Inventory",
  "Ladies Fabric",
  "Ladies Pret",
  "Laundry",
  "Marketing",
  "Paid Marketing",
  "Procurement",
  "Product Sourcing & Procurement",
  "Project Management",
  "Retail Front Operation",
  "Retail Planning & Analytics",
  "Security",
  "SEO",
  "Stitching Unit - KSU",
  "Studio",
  "Supply Chain",
  "Western Apparel",
  "Wholesales Front Operation",
] as const;

/*
 * The first administrator.
 *
 * The email was already configurable; the name was not, and it is not a
 * cosmetic field. First and last name are printed under this person's
 * signature on every memo they sign, and the designation beneath that. A real
 * deployment that set only SEED_ADMIN_EMAIL got a real address attached to a
 * person called "Admin User", signing HR memos, recorded that way in the
 * ledger for good.
 */
const seedValue = (name: string, fallback: string) =>
  process.env[name]?.trim() || fallback;

const ADMIN_EMAIL = seedValue("SEED_ADMIN_EMAIL", "admin@example.com").toLowerCase();
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "password";
const ADMIN_FIRST_NAME = seedValue("SEED_ADMIN_FIRST_NAME", "Admin");
const ADMIN_LAST_NAME = seedValue("SEED_ADMIN_LAST_NAME", "User");
const ADMIN_DESIGNATION = seedValue(
  "SEED_ADMIN_DESIGNATION",
  "System Administrator"
);

async function main() {
  console.log("Running seed...");

  if (process.env.NODE_ENV === "production" && !process.env.SEED_ADMIN_PASSWORD) {
    throw new Error(
      "Refusing to seed a default admin password in production. " +
        "Set SEED_ADMIN_PASSWORD to a strong value."
    );
  }

  for (const name of DEPARTMENTS) {
    await prisma.department.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  console.log(`Departments ready (${DEPARTMENTS.length}).`);

  const department = await prisma.department.findFirst({
    where: { name: "Human Resources" },
  });

  if (!department) {
    throw new Error("Human Resources department not found after seed");
  }

  // Authentication is local now: the password hash lives on the user row,
  // so seeding an account is a single upsert with no external service.
  const passwordHash = await hashPassword(ADMIN_PASSWORD);

  // There is one Super Administrator at a time. On a new install that is this
  // account; once somebody else holds the role, re-running the seed must not
  // hand it back.
  const superAdministrator = await prisma.user.findFirst({
    where: { isSuperAdmin: true, email: { not: ADMIN_EMAIL } },
    select: { id: true },
  });
  const isSuperAdmin = !superAdministrator;

  const user = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    // Designation on the update too: an account seeded before designations
    // existed would otherwise keep signing memos with no office under the
    // name. The NAME is deliberately not updated - re-running the seed must
    // not rewrite who signed the memos already in the ledger.
    // The first administrator of an install is its Super Administrator:
    // somebody has to be able to manage administrators, and on day one there
    // is nobody else.
    update: { passwordHash, designation: ADMIN_DESIGNATION, ...(isSuperAdmin ? { isSuperAdmin } : {}) },
    create: {
      firstName: ADMIN_FIRST_NAME,
      lastName: ADMIN_LAST_NAME,
      // Printed under this person's signature on every memo they sign, so an
      // account without one signs as a name with no office behind it.
      designation: ADMIN_DESIGNATION,
      email: ADMIN_EMAIL,
      passwordHash,
      departmentId: department.id,
      loginRole: "ADMINISTRATOR",
      isSuperAdmin,
    },
  });

  console.log(
    `Administrator ready: ${user.firstName} ${user.lastName} <${user.email}>`
  );
  console.log("Seed completed successfully.");
}

main()
  .catch((err) => {
    console.error("Seed failed:");
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
