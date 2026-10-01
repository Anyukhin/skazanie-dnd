CREATE TABLE "server_link" (
  "id" integer PRIMARY KEY NOT NULL CHECK ("id" = 1),
  "origin" text NOT NULL,
  "updated_at" integer NOT NULL
);
