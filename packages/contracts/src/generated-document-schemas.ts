/* This file is generated from schemas/v1. Run `corepack pnpm contracts:generate` to update it. */

export const calendarSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gitpm.dev/schemas/v1/calendar.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema",
    "id",
    "name",
    "working_weekdays",
    "holidays",
    "lifecycle"
  ],
  "properties": {
    "schema": {
      "const": "gitpm/calendar@1"
    },
    "id": {
      "$ref": "common.schema.json#/$defs/calendarId"
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "working_weekdays": {
      "type": "array",
      "items": {
        "type": "integer",
        "minimum": 1,
        "maximum": 7
      },
      "uniqueItems": true
    },
    "holidays": {
      "type": "array",
      "items": {
        "$ref": "common.schema.json#/$defs/date"
      },
      "uniqueItems": true
    },
    "lifecycle": {
      "$ref": "common.schema.json#/$defs/lifecycle"
    }
  }
} as const;

export const commentSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gitpm.dev/schemas/v1/comment.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema",
    "id",
    "project",
    "task",
    "author",
    "created_at",
    "state",
    "mentions"
  ],
  "properties": {
    "schema": {
      "const": "gitpm/comment@1"
    },
    "id": {
      "$ref": "common.schema.json#/$defs/commentId"
    },
    "project": {
      "$ref": "common.schema.json#/$defs/projectId"
    },
    "task": {
      "$ref": "common.schema.json#/$defs/taskId"
    },
    "author": {
      "$ref": "common.schema.json#/$defs/actor"
    },
    "created_at": {
      "$ref": "common.schema.json#/$defs/timestamp"
    },
    "updated_at": {
      "$ref": "common.schema.json#/$defs/timestamp"
    },
    "state": {
      "enum": [
        "active",
        "deleted"
      ]
    },
    "body_markdown": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32768
    },
    "mentions": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "person",
          "mentioned_at"
        ],
        "properties": {
          "person": {
            "$ref": "common.schema.json#/$defs/personId"
          },
          "mentioned_at": {
            "$ref": "common.schema.json#/$defs/timestamp"
          }
        }
      }
    },
    "deleted_at": {
      "$ref": "common.schema.json#/$defs/timestamp"
    },
    "deleted_by": {
      "$ref": "common.schema.json#/$defs/actor"
    }
  },
  "allOf": [
    {
      "if": {
        "properties": {
          "state": {
            "const": "active"
          }
        }
      },
      "then": {
        "required": [
          "body_markdown"
        ],
        "properties": {
          "body_markdown": {},
          "deleted_at": false,
          "deleted_by": false
        }
      }
    },
    {
      "if": {
        "properties": {
          "state": {
            "const": "deleted"
          }
        }
      },
      "then": {
        "required": [
          "deleted_at",
          "deleted_by"
        ],
        "properties": {
          "body_markdown": false,
          "mentions": {
            "type": "array",
            "maxItems": 0
          },
          "deleted_at": {},
          "deleted_by": {}
        }
      }
    }
  ]
} as const;

export const commonSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gitpm.dev/schemas/v1/common.schema.json",
  "title": "GitPM schema v1 common definitions",
  "$defs": {
    "lifecycle": {
      "enum": [
        "active",
        "archived"
      ]
    },
    "date": {
      "type": "string",
      "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$"
    },
    "slug": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
    },
    "colorToken": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
    },
    "projectId": {
      "type": "string",
      "pattern": "^P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$"
    },
    "taskId": {
      "type": "string",
      "pattern": "^T-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$"
    },
    "milestoneId": {
      "type": "string",
      "pattern": "^M-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$"
    },
    "personId": {
      "type": "string",
      "pattern": "^U-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$"
    },
    "teamId": {
      "type": "string",
      "pattern": "^G-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$"
    },
    "calendarId": {
      "type": "string",
      "pattern": "^C-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$"
    },
    "viewId": {
      "type": "string",
      "pattern": "^V-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$"
    },
    "commentId": {
      "type": "string",
      "pattern": "^N-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$"
    },
    "timestamp": {
      "type": "string",
      "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{3})?Z$"
    },
    "actor": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "provider",
        "subject",
        "display_name"
      ],
      "properties": {
        "provider": {
          "enum": [
            "gitlab",
            "git"
          ]
        },
        "instance": {
          "type": "string",
          "minLength": 1
        },
        "subject": {
          "type": "string",
          "minLength": 1
        },
        "display_name": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "labels": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      },
      "uniqueItems": true
    },
    "configValue": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "slug",
        "title",
        "color",
        "active"
      ],
      "properties": {
        "slug": {
          "$ref": "#/$defs/slug"
        },
        "title": {
          "type": "string",
          "minLength": 1
        },
        "color": {
          "$ref": "#/$defs/colorToken"
        },
        "active": {
          "type": "boolean"
        }
      }
    }
  }
} as const;

export const issueTypesSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gitpm.dev/schemas/v1/issue-types.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema",
    "issue_types"
  ],
  "properties": {
    "schema": {
      "const": "gitpm/issue-types@1"
    },
    "issue_types": {
      "type": "array",
      "minItems": 1,
      "items": {
        "$ref": "common.schema.json#/$defs/configValue"
      }
    }
  }
} as const;

export const milestoneSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gitpm.dev/schemas/v1/milestone.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema",
    "id",
    "project",
    "name",
    "lifecycle"
  ],
  "properties": {
    "schema": {
      "const": "gitpm/milestone@1"
    },
    "id": {
      "$ref": "common.schema.json#/$defs/milestoneId"
    },
    "project": {
      "$ref": "common.schema.json#/$defs/projectId"
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "lifecycle": {
      "$ref": "common.schema.json#/$defs/lifecycle"
    },
    "description_markdown": {
      "type": "string"
    },
    "due": {
      "$ref": "common.schema.json#/$defs/date"
    },
    "task_order": {
      "type": "array",
      "items": {
        "$ref": "common.schema.json#/$defs/taskId"
      },
      "uniqueItems": true
    }
  }
} as const;

export const personSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gitpm.dev/schemas/v1/person.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema",
    "id",
    "name",
    "weekly_capacity_hours",
    "calendar",
    "lifecycle"
  ],
  "properties": {
    "schema": {
      "const": "gitpm/person@1"
    },
    "id": {
      "$ref": "common.schema.json#/$defs/personId"
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "weekly_capacity_hours": {
      "type": "number",
      "minimum": 0
    },
    "calendar": {
      "$ref": "common.schema.json#/$defs/calendarId"
    },
    "lifecycle": {
      "$ref": "common.schema.json#/$defs/lifecycle"
    },
    "email": {
      "type": "string",
      "minLength": 3,
      "maxLength": 254,
      "pattern": "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"
    }
  }
} as const;

export const projectSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gitpm.dev/schemas/v1/project.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema",
    "id",
    "name",
    "status",
    "lifecycle"
  ],
  "properties": {
    "schema": {
      "const": "gitpm/project@1"
    },
    "id": {
      "$ref": "common.schema.json#/$defs/projectId"
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "status": {
      "$ref": "common.schema.json#/$defs/slug"
    },
    "lifecycle": {
      "$ref": "common.schema.json#/$defs/lifecycle"
    },
    "group": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100,
      "pattern": ".*\\S.*"
    },
    "description_markdown": {
      "type": "string"
    },
    "owner": {
      "$ref": "common.schema.json#/$defs/personId"
    },
    "start": {
      "$ref": "common.schema.json#/$defs/date"
    },
    "due": {
      "$ref": "common.schema.json#/$defs/date"
    },
    "milestone_order": {
      "type": "array",
      "items": {
        "$ref": "common.schema.json#/$defs/milestoneId"
      },
      "uniqueItems": true
    },
    "labels": {
      "$ref": "common.schema.json#/$defs/labels"
    }
  }
} as const;

export const repositorySchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gitpm.dev/schemas/v1/repository.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema",
    "default_branch",
    "default_calendar",
    "allowed_top_level_files",
    "ui_poll_interval_seconds"
  ],
  "properties": {
    "schema": {
      "const": "gitpm/repository@1"
    },
    "default_branch": {
      "type": "string",
      "minLength": 1,
      "pattern": "^[^\\s~^:?*\\[\\]\\\\]+$"
    },
    "default_calendar": {
      "$ref": "common.schema.json#/$defs/calendarId"
    },
    "allowed_top_level_files": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "pattern": "^[^/\\\\]+$"
      },
      "uniqueItems": true
    },
    "allowed_top_level_directories": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "pattern": "^[^/\\\\]+$"
      },
      "uniqueItems": true
    },
    "ui_poll_interval_seconds": {
      "type": "integer",
      "minimum": 2,
      "maximum": 10
    }
  }
} as const;

export const savedViewSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gitpm.dev/schemas/v1/saved-view.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema",
    "id",
    "project",
    "name",
    "kind",
    "filters",
    "lifecycle"
  ],
  "properties": {
    "schema": {
      "const": "gitpm/saved-view@1"
    },
    "id": {
      "$ref": "common.schema.json#/$defs/viewId"
    },
    "project": {
      "$ref": "common.schema.json#/$defs/projectId"
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "kind": {
      "enum": [
        "list",
        "board"
      ]
    },
    "filters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "statuses": {
          "type": "array",
          "items": {
            "$ref": "common.schema.json#/$defs/slug"
          },
          "uniqueItems": true
        },
        "types": {
          "type": "array",
          "items": {
            "$ref": "common.schema.json#/$defs/slug"
          },
          "uniqueItems": true
        },
        "assignees": {
          "type": "array",
          "items": {
            "$ref": "common.schema.json#/$defs/personId"
          },
          "uniqueItems": true
        },
        "milestones": {
          "type": "array",
          "items": {
            "$ref": "common.schema.json#/$defs/milestoneId"
          },
          "uniqueItems": true
        },
        "labels": {
          "$ref": "common.schema.json#/$defs/labels"
        }
      }
    },
    "group_by": {
      "enum": [
        "status"
      ]
    },
    "lifecycle": {
      "$ref": "common.schema.json#/$defs/lifecycle"
    }
  }
} as const;

export const statusesSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gitpm.dev/schemas/v1/statuses.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema",
    "statuses"
  ],
  "properties": {
    "schema": {
      "const": "gitpm/statuses@1"
    },
    "statuses": {
      "type": "array",
      "minItems": 1,
      "items": {
        "$ref": "common.schema.json#/$defs/configValue"
      }
    }
  }
} as const;

export const taskSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gitpm.dev/schemas/v1/task.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema",
    "id",
    "project",
    "title",
    "type",
    "status",
    "lifecycle"
  ],
  "properties": {
    "schema": {
      "const": "gitpm/task@1"
    },
    "id": {
      "$ref": "common.schema.json#/$defs/taskId"
    },
    "project": {
      "$ref": "common.schema.json#/$defs/projectId"
    },
    "title": {
      "type": "string",
      "minLength": 1
    },
    "type": {
      "$ref": "common.schema.json#/$defs/slug"
    },
    "status": {
      "$ref": "common.schema.json#/$defs/slug"
    },
    "lifecycle": {
      "$ref": "common.schema.json#/$defs/lifecycle"
    },
    "description_markdown": {
      "type": "string"
    },
    "acceptance_criteria_markdown": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "parent": {
      "$ref": "common.schema.json#/$defs/taskId"
    },
    "milestone": {
      "$ref": "common.schema.json#/$defs/milestoneId"
    },
    "assignees": {
      "type": "array",
      "items": {
        "$ref": "common.schema.json#/$defs/personId"
      },
      "uniqueItems": true
    },
    "estimate_hours": {
      "type": "number",
      "minimum": 0,
      "multipleOf": 0.25
    },
    "start": {
      "$ref": "common.schema.json#/$defs/date"
    },
    "due": {
      "$ref": "common.schema.json#/$defs/date"
    },
    "depends_on": {
      "type": "array",
      "items": {
        "$ref": "common.schema.json#/$defs/taskId"
      },
      "uniqueItems": true
    },
    "labels": {
      "$ref": "common.schema.json#/$defs/labels"
    }
  }
} as const;

export const teamSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gitpm.dev/schemas/v1/team.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema",
    "id",
    "name",
    "members",
    "lifecycle"
  ],
  "properties": {
    "schema": {
      "const": "gitpm/team@1"
    },
    "id": {
      "$ref": "common.schema.json#/$defs/teamId"
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "members": {
      "type": "array",
      "items": {
        "$ref": "common.schema.json#/$defs/personId"
      },
      "uniqueItems": true
    },
    "lifecycle": {
      "$ref": "common.schema.json#/$defs/lifecycle"
    }
  }
} as const;

export const DOCUMENT_SCHEMA_DEFINITIONS = [calendarSchema, commentSchema, commonSchema, issueTypesSchema, milestoneSchema, personSchema, projectSchema, repositorySchema, savedViewSchema, statusesSchema, taskSchema, teamSchema] as const;

export const DOCUMENT_SCHEMAS = {
  "gitpm/calendar@1": calendarSchema,
  "gitpm/comment@1": commentSchema,
  "gitpm/issue-types@1": issueTypesSchema,
  "gitpm/milestone@1": milestoneSchema,
  "gitpm/person@1": personSchema,
  "gitpm/project@1": projectSchema,
  "gitpm/repository@1": repositorySchema,
  "gitpm/saved-view@1": savedViewSchema,
  "gitpm/statuses@1": statusesSchema,
  "gitpm/task@1": taskSchema,
  "gitpm/team@1": teamSchema,
} as const;

export const DOCUMENT_SCHEMA_IDS = {
  "gitpm/calendar@1": "https://gitpm.dev/schemas/v1/calendar.schema.json",
  "gitpm/comment@1": "https://gitpm.dev/schemas/v1/comment.schema.json",
  "gitpm/issue-types@1": "https://gitpm.dev/schemas/v1/issue-types.schema.json",
  "gitpm/milestone@1": "https://gitpm.dev/schemas/v1/milestone.schema.json",
  "gitpm/person@1": "https://gitpm.dev/schemas/v1/person.schema.json",
  "gitpm/project@1": "https://gitpm.dev/schemas/v1/project.schema.json",
  "gitpm/repository@1": "https://gitpm.dev/schemas/v1/repository.schema.json",
  "gitpm/saved-view@1": "https://gitpm.dev/schemas/v1/saved-view.schema.json",
  "gitpm/statuses@1": "https://gitpm.dev/schemas/v1/statuses.schema.json",
  "gitpm/task@1": "https://gitpm.dev/schemas/v1/task.schema.json",
  "gitpm/team@1": "https://gitpm.dev/schemas/v1/team.schema.json",
} as const;

export const DOCUMENT_SCHEMA_FILES = {
  "calendar": "gitpm/calendar@1",
  "comment": "gitpm/comment@1",
  "issue-types": "gitpm/issue-types@1",
  "milestone": "gitpm/milestone@1",
  "person": "gitpm/person@1",
  "project": "gitpm/project@1",
  "repository": "gitpm/repository@1",
  "saved-view": "gitpm/saved-view@1",
  "statuses": "gitpm/statuses@1",
  "task": "gitpm/task@1",
  "team": "gitpm/team@1",
} as const;
