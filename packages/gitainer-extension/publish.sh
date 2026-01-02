#!/bin/bash

# Gitainer Extension Publish Script

# Check if vsce is installed
if ! command -v vsce &> /dev/null
then
    echo "vsce could not be found. Please install it with 'bun install -g @vscode/vsce'."
    exit 1
fi

# Ensure we are in the extension directory
cd "$(dirname "$0")"

# Compile the extension
echo "Compiling extension..."
bun run compile

if [ $? -ne 0 ]; then
    echo "Compilation failed. Aborting."
    exit 1
fi

# Publish the extension
# Usage: ./publish.sh [PAT]
PUBLISH_KEY=$1

if [ -z "$PUBLISH_KEY" ]; then
    if [ -f .env ]; then
        echo "Loading PAT from .env..."
        # Extract GITAINER_MARKETPLACE_PUBLISH_KEY from .env
        PUBLISH_KEY=$(grep '^GITAINER_MARKETPLACE_PUBLISH_KEY=' .env | cut -d '=' -f2- | tr -d '"' | tr -d "'")
    fi
fi

if [ -z "$PUBLISH_KEY" ]; then
    echo "Usage: ./publish.sh <Personal-Access-Token>"
    echo "Alternatively, set GITAINER_MARKETPLACE_PUBLISH_KEY in a .env file."
    echo "You can create a PAT at https://dev.azure.com/"
    exit 1
fi

echo "Publishing extension..."
vsce publish -p $PUBLISH_KEY

if [ $? -eq 0 ]; then
    echo "Extension published successfully!"
else
    echo "Publishing failed."
    exit 1
fi
