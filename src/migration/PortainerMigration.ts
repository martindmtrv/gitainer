import { $ } from "bun";

export interface PortainerStack {
  Id: number;
  Name: string;
  StackFileVersion: number;
};

export interface PortainerStackDb {
  [key: string]: PortainerStack
}

async function migrationScript() {
  // install boltdb dump tool
  console.log("=== 1. Installing tool to dump portainer db ===");
  await $`go install github.com/konoui/boltdb-exporter@latest`

  console.log("=== 2. Preparing directories ===");

  // create portainer path
  await $`mkdir -p ${process.env.MIGRATION_PATH}/portainer`;
  await $`rm -rf ${process.env.MIGRATION_PATH}/portainer/* || true`.quiet();

  // get the gitainer path ready
  await $`mkdir -p ${process.env.MIGRATION_PATH}/gitainer`;
  await $`rm -rf ${process.env.MIGRATION_PATH}/gitainer/* || true`.quiet();

  console.log("=== 3. Extracting Portainer backup ===");

  await $`tar xf ${process.env.MIGRATION_PATH}/portainer-backup* --directory ${process.env.MIGRATION_PATH}/portainer`.quiet();

  console.log("=== 4. Dumping Portainer DB to JSON ===");
  // dump boltdb
  await $`boltdb-exporter --db ${process.env.MIGRATION_PATH}/portainer/portainer.db --format json > ${process.env.MIGRATION_PATH}/portainer/portainer.json`;

  console.log("=== 5. Loading JSON in ===");
  // load the DB
  const file = Bun.file(`${process.env.MIGRATION_PATH}/portainer/portainer.json`);
  const contents = await file.json();

  const stacks = contents.stacks as PortainerStackDb;

  console.log("=== 6. Migrating stacks ===");
  
  for (const stack of Object.values(stacks)) {
    console.log(`Migrating ${stack.Name}`);
    // make a directory and copy over the requisite stackfiles
    await $`mkdir -p ${process.env.MIGRATION_PATH}/gitainer/stacks/${stack.Name}`;
    await $`cp ${process.env.MIGRATION_PATH}/portainer/compose/${stack.Id}/v${stack.StackFileVersion}/docker-compose.yml ${process.env.MIGRATION_PATH}/gitainer/stacks/${stack.Name}/`
  }

  // echo a simple readme
  await $`printf "# Gitainer\n\nMigrated from portainer backup on ${(new Date()).toISOString()}\n" > ${process.env.MIGRATION_PATH}/gitainer/README.md`;

  console.log(`Successfully replicated stacks from Portainer backup!`);
  console.log(`You can copy over the contents of ${process.env.MIGRATION_PATH}/gitainer to your git repo and commit the changes to migrate all the stacks to be managed by gitainer`);
}

await migrationScript();