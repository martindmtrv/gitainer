import { InfisicalSDK, type Secret } from "@infisical/sdk";

let client: InfisicalSDK | undefined = undefined;

export async function getInfisicalProvider() {
  if (client) {
    return client;
  }

  try {
    const newClient = new InfisicalSDK({
      siteUrl: process.env.INFISICAL_URL as string,
    });

    // Authenticate with Infisical
    await newClient.auth().universalAuth.login({
      clientId: process.env.INFISICAL_CLIENT_ID as string,
      clientSecret: process.env.INFISICAL_CLIENT_SECRET as string,
    });

    client = newClient;
    return client;
  } catch (e) {
    console.error("Failed to initialize or authenticate Infisical SDK:", e);
    throw e;
  }
}

export async function getSecrets(): Promise<Secret[] | undefined> {
  if (!process.env.INFISICAL_URL) {
    return undefined;
  }

  console.log("== fetching Infisical secrets ==");

  try {
    const client = await getInfisicalProvider();

    const result = await client.secrets().listSecrets({
      environment: process.env.INFISICAL_PROJECT_ENVIRONMENT as string,
      projectId: process.env.INFISICAL_PROJECT_ID as string,
    });

    return result.secrets;
  } catch (e) {
    console.error("Failed to fetch secrets from Infisical:", e);
    return undefined;
  }
}

export async function updateProcessEnv(): Promise<boolean> {
  const secrets = await getSecrets();

  if (secrets && secrets.length > 0) {
    console.log("== updating process.env from Infisical ==");
    const newEnv: Record<string, string> = {};

    secrets.forEach(secret => {
      let value = secret.secretValue;
      if (value.includes('\n')) {
        console.warn(`[Infisical] Secret "${secret.secretKey}" contains newlines. Flattening to single line.`);
        value = value.replace(/\n/g, ' ');
      }
      newEnv[secret.secretKey] = value;
    });

    Object.assign(process.env, newEnv);
    return true;
  }

  return false;
}
