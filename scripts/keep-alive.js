import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log("Pinging Supabase database to keep it active...");

  // A simple query to wake up the database and register activity
  const result = await prisma.$queryRaw`SELECT 1 as ping`;

  console.log("Database pinged successfully:", result);
}

main()
  .catch((e) => {
    console.error("Error pinging database:", e);
    process.exit(1);
  })
  .finally(async () => {
    console.log("Disconnecting from database...");
    await prisma.$disconnect();
  });
