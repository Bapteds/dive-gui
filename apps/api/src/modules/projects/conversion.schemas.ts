// Zod schemas for the CGNS -> OpenFOAM conversion endpoints.
import { z } from 'zod';

/** Body for converting a CGNS source into the case mesh using a template. */
export const convertCgnsSchema = z.object({
  /** Name of an already-uploaded CGNS file in this project (basename). */
  cgnsFile: z.string().trim().min(1, 'A CGNS file is required'),
  /** Id of the shared template to apply for the surrounding configuration. */
  templateId: z.string().trim().min(1, 'A template is required'),
});

export type ConvertCgnsInput = z.infer<typeof convertCgnsSchema>;

/** Query carrying a CGNS filename (e.g. ?name=rotor.cgns) for deletion. */
export const cgnsNameQuerySchema = z.object({
  name: z.string().trim().min(1, 'A CGNS file name is required'),
});

export type CgnsNameQuery = z.infer<typeof cgnsNameQuerySchema>;
