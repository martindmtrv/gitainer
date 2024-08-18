import { $ } from "bun";

export interface PortainerStack {
  Id: number;
  Name: string;
  StackFileVersion: number;
};

export interface PoratinerStackDb {
  [key: string]: PortainerStack
}

async function migrationScript() {
  // install boltdb dump tool
  await $`go install github.com/konoui/boltdb-exporter@latest`

  // migration folder should be mounted at /var/gitainer/migration
  await $`mkdir -p ${process.env.MIGRATION_PATH}/portainer`;
  await $`rm -rf ${process.env.MIGRATION_PATH}/portainer/* || true`;

  await $`tar xf ${process.env.MIGRATION_PATH}/portainer-backup* --directory ${process.env.MIGRATION_PATH}/portainer`;

  // dump boltdb
  await $`boltdb-exporter --db ${process.env.MIGRATION_PATH}/portainer/portainer.db --format json > ${process.env.MIGRATION_PATH}/portainer/portainer.json`;

  // load the DB
  const file = Bun.file(`${process.env.MIGRATION_PATH}/portainer/portainer.json`);
  const contents = await file.json();

  const stacks = contents.stacks as PoratinerStackDb;

  // get the migrated path ready
  await $`mkdir -p ${process.env.MIGRATION_PATH}/gitainer`;
  await $`rm -rf ${process.env.MIGRATION_PATH}/gitainer/* || true`;

  for (const stack of Object.values(stacks)) {
    // make a directory and copy over the requisite stackfiles
    await $`mkdir -p ${process.env.MIGRATION_PATH}/gitainer/stacks/${stack.Name}`;
    await $`cp ${process.env.MIGRATION_PATH}/portainer/compose/${stack.Id}/v${stack.StackFileVersion}/docker-compose.yml ${process.env.MIGRATION_PATH}/gitainer/stacks/${stack.Name}/`
  }

  console.log(`Successfully replicated stacks from Portainer backup!`);
  console.log(`You can copy over ${process.env.MIGRATION_PATH}/gitainer to your git repo and commit the changes to migrate all the stacks to be managed by gitainer`);
}

await migrationScript();