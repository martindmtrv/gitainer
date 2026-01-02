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
if [ -z "$1" ]; then
    echo "Usage: ./publish.sh <Personal-Access-Token>"
    echo "You can create a PAT at https://dev.azure.com/"
    exit 1
fi

echo "Publishing extension..."
vsce publish -p $1

if [ $? -eq 0 ]; then
    echo "Extension published successfully!"
else
    echo "Publishing failed."
    exit 1
fi
