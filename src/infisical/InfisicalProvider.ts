import { InfisicalSDK, type Secret } from "@infisical/sdk";

let client: InfisicalSDK | undefined = undefined;

export async function getInfisicalProvider() {
  if (client) {
    return client;
  }

  client = new InfisicalSDK({
    siteUrl: process.env.INFISICAL_URL as string,
  });

  // Authenticate with Infisical
  await client.auth().universalAuth.login({
    clientId: process.env.INFISICAL_CLIENT_ID as string,
    clientSecret: process.env.INFISICAL_CLIENT_SECRET as string,
  });

  return client;
}

export async function getSecrets(): Promise<Secret[]> {
  if (!process.env.INFISICAL_URL) {
    return [];
  }

  console.log("== fetching infiscal secrets ==");

  const client = await getInfisicalProvider();

  return (await client.secrets().listSecrets({
    environment: process.env.INFISICAL_PROJECT_ENVIRONMENT as string,
    projectId: process.env.INFISICAL_PROJECT_ID as string,
  })).secrets;
}

export async function updateProcessEnv(): Promise<boolean> {
  const secrets = await getSecrets();

  if (secrets) {
    console.log("== updating process.env from infiscal ==");
    const newEnv: Record<string, string> = {};

    secrets.forEach(secret => {
      newEnv[secret.secretKey] = secret.secretValue;
    });

    Object.assign(process.env, newEnv);
    return true;
  }

  return false;
}
