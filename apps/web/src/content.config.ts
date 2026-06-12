import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// Required on Astro 6 (Content Layer). Starlight 0.40 needs docsLoader() +
// docsSchema(); without this file the docs collection emits zero pages.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
