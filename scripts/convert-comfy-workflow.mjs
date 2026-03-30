#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.error('Usage: node scripts/convert-comfy-workflow.mjs <input-workflow.json> [output-api.json]');
}

function normalizeNodeId(value) {
  return String(value);
}

function buildLinkMap(links) {
  const byId = new Map();

  for (const link of links ?? []) {
    if (!Array.isArray(link) || link.length < 6) {
      continue;
    }

    const [linkId, sourceNodeId, sourceOutputIndex, targetNodeId, targetInputIndex] = link;
    byId.set(linkId, {
      sourceNodeId: normalizeNodeId(sourceNodeId),
      sourceOutputIndex: Number(sourceOutputIndex),
      targetNodeId: normalizeNodeId(targetNodeId),
      targetInputIndex: Number(targetInputIndex)
    });
  }

  return byId;
}

function shouldSkipNode(node) {
  const type = String(node?.type ?? '');

  return (
    !type ||
    type === 'Note' ||
    type.startsWith('Preview') ||
    type.includes('Comparer') ||
    type === 'easy showAnything'
  );
}

function convertWorkflow(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const linkMap = buildLinkMap(workflow?.links);
  const prompt = {};

  for (const node of nodes) {
    if (!node || typeof node !== 'object' || shouldSkipNode(node)) {
      continue;
    }

    const nodeId = normalizeNodeId(node.id);
    const inputs = {};
    const widgetValues = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    let widgetIndex = 0;

    for (const input of node.inputs ?? []) {
      if (!input || typeof input !== 'object' || typeof input.name !== 'string') {
        continue;
      }

      if (input.link !== undefined && input.link !== null) {
        const mappedLink = linkMap.get(input.link);

        if (mappedLink) {
          inputs[input.name] = [mappedLink.sourceNodeId, mappedLink.sourceOutputIndex];
        }
      } else if (input.widget) {
        if (widgetIndex < widgetValues.length) {
          inputs[input.name] = widgetValues[widgetIndex];
        }
      }

      if (input.widget) {
        widgetIndex += 1;
      }
    }

    prompt[nodeId] = {
      inputs,
      class_type: String(node.type)
    };

    if (node.title) {
      prompt[nodeId]._meta = {
        title: String(node.title)
      };
    }
  }

  return prompt;
}

function main() {
  const [, , inputPath, outputPath] = process.argv;

  if (!inputPath) {
    usage();
    process.exitCode = 1;
    return;
  }

  const absoluteInputPath = path.resolve(process.cwd(), inputPath);
  const raw = fs.readFileSync(absoluteInputPath, 'utf8');
  const parsed = JSON.parse(raw);
  const converted = convertWorkflow(parsed);
  const serialized = `${JSON.stringify(converted, null, 2)}\n`;

  if (outputPath) {
    const absoluteOutputPath = path.resolve(process.cwd(), outputPath);
    fs.writeFileSync(absoluteOutputPath, serialized, 'utf8');
    console.error(`Converted workflow written to ${absoluteOutputPath}`);
    return;
  }

  process.stdout.write(serialized);
}

main();
