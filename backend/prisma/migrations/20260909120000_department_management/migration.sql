-- Departments become something an administrator can manage.
--
-- Until now the only department operation in the product was reading the list.
-- They could be created by the seed script or by a database prompt and by
-- nothing else, which means adding one required access to the server - and a
-- person cannot be created without a department, so onboarding somebody into a
-- new team was blocked on an engineer.

-- Removing a department outright is a distinct act from deactivating one, and
-- the trail should say which happened. The other two values have existed since
-- the first migration and were never written by anything.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DEPARTMENT_DELETED';

-- Case-insensitive uniqueness, which `@unique` on the column does not give.
--
-- "Finance" and "finance" could both exist, and the bulk user import builds a
-- map from lowercased department name to department: two rows collapsing to
-- one key means the map silently keeps whichever came last, and imported
-- people are quietly assigned to the wrong one. That is the kind of defect
-- nobody finds until somebody asks why a memo went to the wrong head of
-- department.
--
-- An expression index cannot be written in the Prisma schema. `migrate diff`
-- was checked against a database holding this index and does not try to drop
-- what it cannot model, so it survives future migrations; the Department model
-- carries a comment saying it exists.
--
-- This will fail loudly on any database that already holds two names differing
-- only by case, which is the correct outcome: they have to be reconciled by
-- somebody who knows which is which, not by a migration guessing.
CREATE UNIQUE INDEX IF NOT EXISTS "departments_name_lower_key"
  ON "departments" (lower("name"));
