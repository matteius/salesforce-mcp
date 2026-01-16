/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { z } from 'zod';
import { Connection, SfError } from '@salesforce/core';
import { McpTool, McpToolConfig, ReleaseState, Services, Toolset } from '@salesforce/mcp-provider-api';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { directoryParam, usernameOrAliasParam } from '../shared/params.js';
import { textResponse } from '../shared/utils.js';

// Supported field types
const fieldTypeEnum = z.enum([
  'Text',
  'Number',
  'Checkbox',
  'Date',
  'DateTime',
  'Email',
  'Phone',
  'Url',
  'Currency',
  'Percent',
  'TextArea',
  'LongTextArea',
  'RichTextArea',
  'Picklist',
  'MultiselectPicklist',
  'Lookup',
  'MasterDetail',
]);

// Picklist value schema
const picklistValueSchema = z.object({
  value: z.string().describe('The picklist value'),
  isDefault: z.boolean().optional().describe('Whether this is the default value'),
});

// Field definition schema
const fieldDefinitionSchema = z.object({
  objectApiName: z.string().describe('API name of the object (e.g., Account, MyObject__c)'),
  fieldApiName: z.string().describe('API name of the field without __c suffix (e.g., MyField)'),
  label: z.string().describe('Field label displayed to users'),
  type: fieldTypeEnum.describe('Field data type'),
  description: z.string().optional().describe('Field description'),
  helpText: z.string().optional().describe('Inline help text for the field'),
  required: z.boolean().optional().describe('Whether the field is required'),
  unique: z.boolean().optional().describe('Whether values must be unique'),
  externalId: z.boolean().optional().describe('Whether this field is an external ID'),
  // Type-specific options
  length: z.number().optional().describe('Length for Text fields (max 255)'),
  precision: z.number().optional().describe('Total digits for Number/Currency/Percent'),
  scale: z.number().optional().describe('Decimal places for Number/Currency/Percent'),
  visibleLines: z.number().optional().describe('Visible lines for TextArea/LongTextArea'),
  picklistValues: z.array(picklistValueSchema).optional().describe('Values for Picklist/MultiselectPicklist'),
  referenceTo: z.string().optional().describe('Target object for Lookup/MasterDetail'),
  relationshipName: z.string().optional().describe('Relationship name for Lookup/MasterDetail'),
  relationshipLabel: z.string().optional().describe('Relationship label for Lookup/MasterDetail'),
  deleteConstraint: z.enum(['SetNull', 'Restrict', 'Cascade']).optional().describe('Delete behavior for Lookup'),
});

// Permission assignment schema
const permissionAssignmentSchema = z.object({
  permissionSetOrProfile: z.string().describe('API name of the Permission Set or Profile'),
  readable: z.boolean().describe('Whether the field is readable'),
  editable: z.boolean().describe('Whether the field is editable'),
});

// Main input schema
export const createCustomFieldsParams = z.object({
  fields: z.array(fieldDefinitionSchema).min(1).describe('Array of field definitions to create'),
  permissions: z.array(permissionAssignmentSchema).optional().describe(
    `Permission assignments for the new fields. Each permission set/profile listed will get the specified access to ALL fields being created.

AGENT INSTRUCTIONS:
Ask the user which permission sets or profiles should have access to the new fields if not specified.`
  ),
  usernameOrAlias: usernameOrAliasParam,
  directory: directoryParam,
});

type InputArgs = z.infer<typeof createCustomFieldsParams>;
type InputArgsShape = typeof createCustomFieldsParams.shape;
type OutputArgsShape = z.ZodRawShape;
type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;
type PermissionAssignment = z.infer<typeof permissionAssignmentSchema>;

export class CreateCustomFieldsMcpTool extends McpTool<InputArgsShape, OutputArgsShape> {
  public constructor(private readonly services: Services) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.NON_GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.METADATA];
  }

  public getName(): string {
    return 'create_custom_fields';
  }

  public getConfig(): McpToolConfig<InputArgsShape, OutputArgsShape> {
    return {
      title: 'Create Custom Fields',
      description: `Create custom fields in bulk with automatic permission assignment.

AGENT INSTRUCTIONS:
- This tool creates custom fields on Salesforce objects and optionally assigns field-level security permissions.
- Always ask the user for permission assignments if not specified - this saves significant time.
- Field API names should NOT include the __c suffix - it will be added automatically.

EXAMPLE USAGE:
Create a Text field called "External ID" on Account
Create 3 fields on Contact: Email, Phone, and a Picklist for Status
Create a Lookup field from Case to Account with read/edit access for the Sales Profile`,
      inputSchema: createCustomFieldsParams.shape,
      outputSchema: undefined,
      annotations: {
        destructiveHint: true,
        openWorldHint: false,
      },
    };
  }

  public async exec(input: InputArgs): Promise<CallToolResult> {
    if (!input.usernameOrAlias) {
      return textResponse(
        'The usernameOrAlias parameter is required. Use the #get_username tool if not specified.',
        true
      );
    }

    process.chdir(input.directory);

    try {
      const connection = await this.services.getOrgService().getConnection(input.usernameOrAlias);
      const result = await this.deployFieldsAndPermissions(connection, input.fields, input.permissions);
      return result;
    } catch (error) {
      const err = SfError.wrap(error);
      return textResponse(`Failed to create custom fields: ${err.message}`, true);
    }
  }

  private async deployFieldsAndPermissions(
    connection: Connection,
    fields: FieldDefinition[],
    permissions?: PermissionAssignment[]
  ): Promise<CallToolResult> {
    // Build metadata items for all fields
    const metadataItems = fields.map(field => {
      const fullFieldName = field.fieldApiName.endsWith('__c')
        ? field.fieldApiName
        : `${field.fieldApiName}__c`;
      return {
        type: 'CustomField',
        fullName: `${field.objectApiName}.${fullFieldName}`,
        ...this.buildFieldMetadata(field),
      };
    });

    // Deploy fields first
    const deployResult = await connection.metadata.create('CustomField', metadataItems as any);
    const results = Array.isArray(deployResult) ? deployResult : [deployResult];

    const successFields: string[] = [];
    const failedFields: string[] = [];

    for (const result of results) {
      if (result.success) {
        successFields.push(result.fullName);
      } else {
        const errors = Array.isArray(result.errors) ? result.errors : [result.errors];
        failedFields.push(`${result.fullName}: ${errors.map((e: any) => e.message).join(', ')}`);
      }
    }

    // Now update permissions if specified
    let permissionResults = '';
    if (permissions && permissions.length > 0 && successFields.length > 0) {
      permissionResults = await this.assignFieldPermissions(connection, successFields, permissions);
    }

    const summary = this.buildResultSummary(successFields, failedFields, permissionResults);
    return textResponse(summary, failedFields.length > 0);
  }



  private buildFieldMetadata(field: FieldDefinition): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      label: field.label,
      type: this.mapFieldType(field.type),
      description: field.description,
      inlineHelpText: field.helpText,
      required: field.required ?? false,
      unique: field.unique ?? false,
      externalId: field.externalId ?? false,
    };

    // Type-specific properties
    switch (field.type) {
      case 'Text':
        metadata.length = field.length ?? 255;
        break;
      case 'Number':
      case 'Currency':
      case 'Percent':
        metadata.precision = field.precision ?? 18;
        metadata.scale = field.scale ?? 2;
        break;
      case 'TextArea':
        metadata.length = field.length ?? 255;
        break;
      case 'LongTextArea':
      case 'RichTextArea':
        metadata.length = field.length ?? 32768;
        metadata.visibleLines = field.visibleLines ?? 6;
        break;
      case 'Picklist':
      case 'MultiselectPicklist':
        if (field.picklistValues && field.picklistValues.length > 0) {
          metadata.valueSet = {
            restricted: true,
            valueSetDefinition: {
              sorted: false,
              value: field.picklistValues.map(pv => ({
                fullName: pv.value,
                default: pv.isDefault ?? false,
                label: pv.value,
              })),
            },
          };
        }
        if (field.type === 'MultiselectPicklist') {
          metadata.visibleLines = field.visibleLines ?? 4;
        }
        break;
      case 'Lookup':
      case 'MasterDetail':
        metadata.referenceTo = field.referenceTo;
        metadata.relationshipName = field.relationshipName ?? field.fieldApiName + 's';
        metadata.relationshipLabel = field.relationshipLabel ?? field.label + 's';
        if (field.type === 'Lookup') {
          metadata.deleteConstraint = field.deleteConstraint ?? 'SetNull';
        }
        break;
    }

    // Remove undefined values
    return Object.fromEntries(Object.entries(metadata).filter(([_, v]) => v !== undefined));
  }

  private mapFieldType(type: string): string {
    const typeMap: Record<string, string> = {
      'Text': 'Text',
      'Number': 'Number',
      'Checkbox': 'Checkbox',
      'Date': 'Date',
      'DateTime': 'DateTime',
      'Email': 'Email',
      'Phone': 'Phone',
      'Url': 'Url',
      'Currency': 'Currency',
      'Percent': 'Percent',
      'TextArea': 'TextArea',
      'LongTextArea': 'LongTextArea',
      'RichTextArea': 'Html',
      'Picklist': 'Picklist',
      'MultiselectPicklist': 'MultiselectPicklist',
      'Lookup': 'Lookup',
      'MasterDetail': 'MasterDetail',
    };
    return typeMap[type] ?? type;
  }

  private async assignFieldPermissions(
    connection: Connection,
    fieldNames: string[],
    permissions: PermissionAssignment[]
  ): Promise<string> {
    const results: string[] = [];

    for (const perm of permissions) {
      try {
        // Build field permissions for the permission set
        const fieldPermissions = fieldNames.map(fieldName => ({
          field: fieldName,
          readable: perm.readable,
          editable: perm.editable,
        }));

        // Try updating as PermissionSet first
        try {
          const updateResult = await connection.metadata.update('PermissionSet', {
            fullName: perm.permissionSetOrProfile,
            fieldPermissions,
          } as any);

          const result = Array.isArray(updateResult) ? updateResult[0] : updateResult;
          if (result.success) {
            results.push(`✓ Permission Set "${perm.permissionSetOrProfile}": assigned`);
          } else {
            // If PermissionSet fails, try as Profile
            const profileResult = await connection.metadata.update('Profile', {
              fullName: perm.permissionSetOrProfile,
              fieldPermissions,
            } as any);

            const pResult = Array.isArray(profileResult) ? profileResult[0] : profileResult;
            if (pResult.success) {
              results.push(`✓ Profile "${perm.permissionSetOrProfile}": assigned`);
            } else {
              const errors = Array.isArray(pResult.errors) ? pResult.errors : [pResult.errors];
              results.push(`✗ "${perm.permissionSetOrProfile}": ${errors.map((e: any) => e?.message).join(', ')}`);
            }
          }
        } catch (permSetError) {
          // Try as Profile if PermissionSet fails
          const profileResult = await connection.metadata.update('Profile', {
            fullName: perm.permissionSetOrProfile,
            fieldPermissions,
          } as any);

          const pResult = Array.isArray(profileResult) ? profileResult[0] : profileResult;
          if (pResult.success) {
            results.push(`✓ Profile "${perm.permissionSetOrProfile}": assigned`);
          } else {
            const errors = Array.isArray(pResult.errors) ? pResult.errors : [pResult.errors];
            results.push(`✗ "${perm.permissionSetOrProfile}": ${errors.map((e: any) => e?.message).join(', ')}`);
          }
        }
      } catch (error) {
        results.push(`✗ "${perm.permissionSetOrProfile}": ${(error as Error).message}`);
      }
    }

    return results.join('\n');
  }

  private buildResultSummary(
    successFields: string[],
    failedFields: string[],
    permissionResults: string
  ): string {
    const parts: string[] = [];

    if (successFields.length > 0) {
      parts.push(`Successfully created ${successFields.length} field(s):`);
      parts.push(successFields.map(f => `  ✓ ${f}`).join('\n'));
    }

    if (failedFields.length > 0) {
      parts.push(`\nFailed to create ${failedFields.length} field(s):`);
      parts.push(failedFields.map(f => `  ✗ ${f}`).join('\n'));
    }

    if (permissionResults) {
      parts.push('\nPermission assignments:');
      parts.push(permissionResults);
    }

    return parts.join('\n');
  }
}
