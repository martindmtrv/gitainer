#!/bin/sh

output=$(docker compose --ansi never -f /self-update.yaml -p "$STACK_NAME" up -d --force-recreate 2>&1)
status=$?
printf '%s\n' "$output"

if [ -z "$SELF_UPDATE_WEBHOOK_URL" ]; then
  exit $status
fi

# no jq in the helper image: escape backslashes, quotes and control chars, and join lines with \n
json_str() {
  printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | awk 'BEGIN { ORS = "" } {
    gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r");
    if (NR > 1) print "\\n";
    print
  }'
}

if [ $status -eq 0 ]; then
  result="\"msg\": \"$(json_str "Successfully self-updated stack $STACK_NAME: the helper container recreated it")\""
else
  result="\"err\": \"$(json_str "Self-update of stack $STACK_NAME failed in the helper container (exit code $status): $output")\""
fi

payload="{\"title\": \"$(json_str "$SELF_UPDATE_WEBHOOK_TITLE")\", \"stackName\": \"$(json_str "$STACK_NAME")\", $result, \"output\": \"$(json_str "$output")\"}"

echo "== Sending POST to $SELF_UPDATE_WEBHOOK_URL =="
wget -q -T 30 -O /dev/null --header "Content-Type: application/json" --post-data "$payload" "$SELF_UPDATE_WEBHOOK_URL" \
  || echo "Failed to send the self-update webhook notification"

exit $status
