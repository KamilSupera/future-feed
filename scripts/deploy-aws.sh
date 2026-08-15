#!/usr/bin/env bash
set -euo pipefail

FUNCTION=${FUNCTION:-future-feed}
ROLE=${ROLE:-future-feed-lambda}
REGION=${REGION:-$(aws configure get region)}
RUNTIME=nodejs22.x
ARCH=arm64
MEMORY=512
TIMEOUT=15
LOG_RETENTION_DAYS=7

cd "$(dirname "$0")/.."

if [[ -z "${NEWSDATA_API_KEY:-}" && -f .env ]]; then
  set -a && . ./.env && set +a
fi
: "${NEWSDATA_API_KEY:?set NEWSDATA_API_KEY or put it in .env}"

echo "==> build"
rm -rf .output
NITRO_PRESET=aws-lambda npx vite build >/dev/null
echo '{"type":"module"}' >.output/package.json

echo "==> package"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ZIP="$TMP/function.zip"
(cd .output && zip -qr "$ZIP" server public package.json)
echo "    $(du -h "$ZIP" | cut -f1)"

echo "==> iam role"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "    created, waiting for propagation"
  sleep 10
fi
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)

echo "==> lambda"
if aws lambda get-function --function-name "$FUNCTION" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FUNCTION" --region "$REGION" \
    --zip-file "fileb://$ZIP" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION" --region "$REGION"
  aws lambda update-function-configuration --function-name "$FUNCTION" --region "$REGION" \
    --memory-size "$MEMORY" --timeout "$TIMEOUT" \
    --environment "Variables={NEWSDATA_API_KEY=$NEWSDATA_API_KEY}" >/dev/null
else
  aws lambda create-function --function-name "$FUNCTION" --region "$REGION" \
    --runtime "$RUNTIME" --architectures "$ARCH" --handler server/index.handler \
    --role "$ROLE_ARN" --memory-size "$MEMORY" --timeout "$TIMEOUT" \
    --environment "Variables={NEWSDATA_API_KEY=$NEWSDATA_API_KEY}" \
    --zip-file "fileb://$ZIP" >/dev/null
fi
aws lambda wait function-updated --function-name "$FUNCTION" --region "$REGION"

# The function URL stays on AWS_IAM: this account cannot expose an anonymous
# one, and CloudFront signs every origin request with SigV4 via OAC anyway.
echo "==> function url"
if ! aws lambda get-function-url-config --function-name "$FUNCTION" --region "$REGION" >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name "$FUNCTION" --region "$REGION" \
    --auth-type AWS_IAM >/dev/null
else
  aws lambda update-function-url-config --function-name "$FUNCTION" --region "$REGION" \
    --auth-type AWS_IAM >/dev/null
fi
ORIGIN=$(aws lambda get-function-url-config --function-name "$FUNCTION" --region "$REGION" \
  --query FunctionUrl --output text | sed -E 's#^https://##; s#/$##')

echo "==> origin access control"
OAC=$(aws cloudfront list-origin-access-controls \
  --query "OriginAccessControlList.Items[?Name=='$FUNCTION-oac'].Id | [0]" --output text)
if [[ "$OAC" == "None" || -z "$OAC" ]]; then
  OAC=$(aws cloudfront create-origin-access-control --origin-access-control-config \
    "{\"Name\":\"$FUNCTION-oac\",\"Description\":\"$FUNCTION lambda url\",\"SigningProtocol\":\"sigv4\",\"SigningBehavior\":\"always\",\"OriginAccessControlOriginType\":\"lambda\"}" \
    --query OriginAccessControl.Id --output text)
fi

echo "==> cloudfront"
DIST=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='$FUNCTION'].Id | [0]" --output text 2>/dev/null || echo None)
if [[ "$DIST" == "None" || -z "$DIST" ]]; then
  cat >"$TMP/dist.json" <<JSON
{
  "CallerReference": "$FUNCTION-$(date +%s)",
  "Comment": "$FUNCTION",
  "Enabled": true,
  "PriceClass": "PriceClass_100",
  "HttpVersion": "http2and3",
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "lambda-url",
      "DomainName": "$ORIGIN",
      "OriginAccessControlId": "$OAC",
      "CustomOriginConfig": {
        "HTTPPort": 80,
        "HTTPSPort": 443,
        "OriginProtocolPolicy": "https-only",
        "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] }
      }
    }]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "lambda-url",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 7,
      "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
      "CachedMethods": { "Quantity": 2, "Items": ["GET","HEAD"] }
    },
    "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    "Compress": true
  },
  "CacheBehaviors": {
    "Quantity": 1,
    "Items": [{
      "PathPattern": "/assets/*",
      "TargetOriginId": "lambda-url",
      "ViewerProtocolPolicy": "redirect-to-https",
      "AllowedMethods": {
        "Quantity": 2,
        "Items": ["GET","HEAD"],
        "CachedMethods": { "Quantity": 2, "Items": ["GET","HEAD"] }
      },
      "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
      "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac",
      "Compress": true
    }]
  }
}
JSON
  DIST=$(aws cloudfront create-distribution --distribution-config "file://$TMP/dist.json" \
    --query Distribution.Id --output text)
fi
DIST_ARN=$(aws cloudfront get-distribution --id "$DIST" --query Distribution.ARN --output text)
URL="https://$(aws cloudfront get-distribution --id "$DIST" --query Distribution.DomainName --output text)/"

# A function URL needs both grants: one to reach the URL, one to invoke the
# function behind it. With only the first, every request 403s.
aws lambda remove-permission --function-name "$FUNCTION" --region "$REGION" \
  --statement-id AllowCloudFrontUrl 2>/dev/null || true
aws lambda add-permission --function-name "$FUNCTION" --region "$REGION" \
  --statement-id AllowCloudFrontUrl --action lambda:InvokeFunctionUrl \
  --principal cloudfront.amazonaws.com --source-arn "$DIST_ARN" \
  --function-url-auth-type AWS_IAM >/dev/null

aws lambda remove-permission --function-name "$FUNCTION" --region "$REGION" \
  --statement-id AllowCloudFrontInvoke 2>/dev/null || true
aws lambda add-permission --function-name "$FUNCTION" --region "$REGION" \
  --statement-id AllowCloudFrontInvoke --action lambda:InvokeFunction \
  --principal cloudfront.amazonaws.com --source-arn "$DIST_ARN" >/dev/null

aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" \
  --query Invalidation.Id --output text >/dev/null

aws logs put-retention-policy --log-group-name "/aws/lambda/$FUNCTION" \
  --retention-in-days "$LOG_RETENTION_DAYS" --region "$REGION" 2>/dev/null || true


echo
echo "live: $URL"
