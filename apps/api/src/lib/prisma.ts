// Single shared PrismaClient instance for the whole API.
// Importing this module everywhere avoids opening multiple connection pools.
import { PrismaClient } from '@prisma/client';

/** The one and only Prisma client used across the application. */
export const prisma = new PrismaClient();
