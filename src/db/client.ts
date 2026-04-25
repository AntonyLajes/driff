import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { execute as loadEnv } from "@/config/env.js";
import * as schema from "@/db/schema.js";

export interface ExecuteInput {
  databaseUrl?: string;
}

export const execute = (input: ExecuteInput = {}) => {
  const databaseUrl = input.databaseUrl ?? loadEnv().DATABASE_URL;
  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema });

  return { client, db };
};
