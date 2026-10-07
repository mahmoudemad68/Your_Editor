/* eslint-disable -- Generated schema validator. Do not edit. */
"use strict";
export const validate = validate20;
export default validate20;
const schema31 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://editagent.dev/schemas/job-event.v1.json",
  title: "JobEventV1",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    eventId: {
      type: "string",
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]*$",
    },
    jobId: {
      type: "string",
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    },
    projectId: {
      type: "string",
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    },
    jobType: { type: "string", pattern: "^[a-z][a-z0-9.-]{0,63}$" },
    sequence: { type: "integer", minimum: 1, maximum: 9007199254740991 },
    attempt: { type: "integer", minimum: 0 },
    occurredAt: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
    },
    correlationId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
    kind: { enum: ["state", "progress"] },
    percentage: { type: "number", minimum: 0, maximum: 100 },
    stage: {
      enum: [
        "staging",
        "validating",
        "probing",
        "decoding",
        "proxy",
        "asr",
        "mix",
        "poster",
        "sprite",
        "uploading",
        "finalizing",
      ],
    },
    status: { enum: ["Queued", "Running", "Retrying", "Completed", "Failed", "Cancelled"] },
    reason: { enum: ["processing_failed", "cancelled"] },
  },
  required: [
    "schemaVersion",
    "eventId",
    "jobId",
    "projectId",
    "jobType",
    "sequence",
    "attempt",
    "occurredAt",
    "kind",
  ],
  oneOf: [
    {
      properties: { kind: { const: "progress" }, attempt: { minimum: 1 } },
      required: ["percentage", "stage"],
      not: { anyOf: [{ required: ["status"] }, { required: ["reason"] }] },
    },
    {
      properties: { kind: { const: "state" } },
      required: ["status"],
      not: { anyOf: [{ required: ["percentage"] }, { required: ["stage"] }] },
      allOf: [
        {
          if: { properties: { status: { enum: ["Running", "Retrying", "Completed", "Failed"] } } },
          then: { properties: { attempt: { minimum: 1 } } },
        },
        {
          if: { properties: { status: { const: "Queued" } } },
          then: { properties: { attempt: { const: 0 } } },
        },
      ],
    },
  ],
};
const func1 = Object.prototype.hasOwnProperty;
const pattern4 = new RegExp(
  "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]*$",
  "u",
);
const pattern5 = new RegExp(
  "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  "u",
);
const pattern7 = new RegExp("^[a-z][a-z0-9.-]{0,63}$", "u");
const pattern8 = new RegExp("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$", "u");
const pattern9 = new RegExp("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", "u");
function validate20(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {},
) {
  /*# sourceURL="https://editagent.dev/schemas/job-event.v1.json" */ let vErrors = null;
  let errors = 0;
  const evaluated0 = validate20.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  const _errs1 = errors;
  let valid0 = false;
  let passing0 = null;
  const _errs2 = errors;
  const _errs3 = errors;
  const _errs4 = errors;
  const _errs5 = errors;
  let valid2 = false;
  const _errs6 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    let missing0;
    if (data.status === undefined && (missing0 = "status")) {
      const err0 = {};
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
  }
  var _valid1 = _errs6 === errors;
  valid2 = valid2 || _valid1;
  const _errs7 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    let missing1;
    if (data.reason === undefined && (missing1 = "reason")) {
      const err1 = {};
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
  }
  var _valid1 = _errs7 === errors;
  valid2 = valid2 || _valid1;
  if (!valid2) {
    const err2 = {};
    if (vErrors === null) {
      vErrors = [err2];
    } else {
      vErrors.push(err2);
    }
    errors++;
  } else {
    errors = _errs5;
    if (vErrors !== null) {
      if (_errs5) {
        vErrors.length = _errs5;
      } else {
        vErrors = null;
      }
    }
  }
  var valid1 = _errs4 === errors;
  if (valid1) {
    const err3 = {
      instancePath,
      schemaPath: "#/oneOf/0/not",
      keyword: "not",
      params: {},
      message: "must NOT be valid",
    };
    if (vErrors === null) {
      vErrors = [err3];
    } else {
      vErrors.push(err3);
    }
    errors++;
  } else {
    errors = _errs3;
    if (vErrors !== null) {
      if (_errs3) {
        vErrors.length = _errs3;
      } else {
        vErrors = null;
      }
    }
  }
  if (errors === _errs2) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing2;
      if (
        (data.percentage === undefined && (missing2 = "percentage")) ||
        (data.stage === undefined && (missing2 = "stage"))
      ) {
        const err4 = {
          instancePath,
          schemaPath: "#/oneOf/0/required",
          keyword: "required",
          params: { missingProperty: missing2 },
          message: "must have required property '" + missing2 + "'",
        };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      } else {
        if (data.kind !== undefined) {
          const _errs8 = errors;
          if ("progress" !== data.kind) {
            const err5 = {
              instancePath: instancePath + "/kind",
              schemaPath: "#/oneOf/0/properties/kind/const",
              keyword: "const",
              params: { allowedValue: "progress" },
              message: "must be equal to constant",
            };
            if (vErrors === null) {
              vErrors = [err5];
            } else {
              vErrors.push(err5);
            }
            errors++;
          }
          var valid3 = _errs8 === errors;
        } else {
          var valid3 = true;
        }
        if (valid3) {
          if (data.attempt !== undefined) {
            let data1 = data.attempt;
            const _errs9 = errors;
            if (typeof data1 == "number") {
              if (data1 < 1 || isNaN(data1)) {
                const err6 = {
                  instancePath: instancePath + "/attempt",
                  schemaPath: "#/oneOf/0/properties/attempt/minimum",
                  keyword: "minimum",
                  params: { comparison: ">=", limit: 1 },
                  message: "must be >= 1",
                };
                if (vErrors === null) {
                  vErrors = [err6];
                } else {
                  vErrors.push(err6);
                }
                errors++;
              }
            }
            var valid3 = _errs9 === errors;
          } else {
            var valid3 = true;
          }
        }
      }
    }
  }
  var _valid0 = _errs2 === errors;
  if (_valid0) {
    valid0 = true;
    passing0 = 0;
    var props0 = {};
    props0.kind = true;
    props0.attempt = true;
  }
  const _errs10 = errors;
  const _errs11 = errors;
  const _errs12 = errors;
  const _errs13 = errors;
  let valid5 = false;
  const _errs14 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    let missing3;
    if (data.percentage === undefined && (missing3 = "percentage")) {
      const err7 = {};
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
  }
  var _valid2 = _errs14 === errors;
  valid5 = valid5 || _valid2;
  const _errs15 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    let missing4;
    if (data.stage === undefined && (missing4 = "stage")) {
      const err8 = {};
      if (vErrors === null) {
        vErrors = [err8];
      } else {
        vErrors.push(err8);
      }
      errors++;
    }
  }
  var _valid2 = _errs15 === errors;
  valid5 = valid5 || _valid2;
  if (!valid5) {
    const err9 = {};
    if (vErrors === null) {
      vErrors = [err9];
    } else {
      vErrors.push(err9);
    }
    errors++;
  } else {
    errors = _errs13;
    if (vErrors !== null) {
      if (_errs13) {
        vErrors.length = _errs13;
      } else {
        vErrors = null;
      }
    }
  }
  var valid4 = _errs12 === errors;
  if (valid4) {
    const err10 = {
      instancePath,
      schemaPath: "#/oneOf/1/not",
      keyword: "not",
      params: {},
      message: "must NOT be valid",
    };
    if (vErrors === null) {
      vErrors = [err10];
    } else {
      vErrors.push(err10);
    }
    errors++;
  } else {
    errors = _errs11;
    if (vErrors !== null) {
      if (_errs11) {
        vErrors.length = _errs11;
      } else {
        vErrors = null;
      }
    }
    const _errs16 = errors;
    const _errs17 = errors;
    let valid7 = true;
    const _errs18 = errors;
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.status !== undefined) {
        let data2 = data.status;
        if (!(
          data2 === "Running" ||
          data2 === "Retrying" ||
          data2 === "Completed" ||
          data2 === "Failed"
        )) {
          const err11 = {};
          if (vErrors === null) {
            vErrors = [err11];
          } else {
            vErrors.push(err11);
          }
          errors++;
        }
      }
    }
    var _valid3 = _errs18 === errors;
    errors = _errs17;
    if (vErrors !== null) {
      if (_errs17) {
        vErrors.length = _errs17;
      } else {
        vErrors = null;
      }
    }
    if (_valid3) {
      const _errs20 = errors;
      if (data && typeof data == "object" && !Array.isArray(data)) {
        if (data.attempt !== undefined) {
          let data3 = data.attempt;
          if (typeof data3 == "number") {
            if (data3 < 1 || isNaN(data3)) {
              const err12 = {
                instancePath: instancePath + "/attempt",
                schemaPath: "#/oneOf/1/allOf/0/then/properties/attempt/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err12];
              } else {
                vErrors.push(err12);
              }
              errors++;
            }
          }
        }
      }
      var _valid3 = _errs20 === errors;
      valid7 = _valid3;
      if (valid7) {
        var props1 = {};
        props1.attempt = true;
        props1.status = true;
      }
    }
    if (!valid7) {
      const err13 = {
        instancePath,
        schemaPath: "#/oneOf/1/allOf/0/if",
        keyword: "if",
        params: { failingKeyword: "then" },
        message: 'must match "then" schema',
      };
      if (vErrors === null) {
        vErrors = [err13];
      } else {
        vErrors.push(err13);
      }
      errors++;
    }
    var valid6 = _errs16 === errors;
    if (valid6) {
      const _errs22 = errors;
      const _errs23 = errors;
      let valid10 = true;
      const _errs24 = errors;
      if (data && typeof data == "object" && !Array.isArray(data)) {
        if (data.status !== undefined) {
          if ("Queued" !== data.status) {
            const err14 = {};
            if (vErrors === null) {
              vErrors = [err14];
            } else {
              vErrors.push(err14);
            }
            errors++;
          }
        }
      }
      var _valid4 = _errs24 === errors;
      errors = _errs23;
      if (vErrors !== null) {
        if (_errs23) {
          vErrors.length = _errs23;
        } else {
          vErrors = null;
        }
      }
      if (_valid4) {
        const _errs26 = errors;
        if (data && typeof data == "object" && !Array.isArray(data)) {
          if (data.attempt !== undefined) {
            if (0 !== data.attempt) {
              const err15 = {
                instancePath: instancePath + "/attempt",
                schemaPath: "#/oneOf/1/allOf/1/then/properties/attempt/const",
                keyword: "const",
                params: { allowedValue: 0 },
                message: "must be equal to constant",
              };
              if (vErrors === null) {
                vErrors = [err15];
              } else {
                vErrors.push(err15);
              }
              errors++;
            }
          }
        }
        var _valid4 = _errs26 === errors;
        valid10 = _valid4;
        if (valid10) {
          var props2 = {};
          props2.attempt = true;
          props2.status = true;
        }
      }
      if (!valid10) {
        const err16 = {
          instancePath,
          schemaPath: "#/oneOf/1/allOf/1/if",
          keyword: "if",
          params: { failingKeyword: "then" },
          message: 'must match "then" schema',
        };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
      var valid6 = _errs22 === errors;
      if (valid6) {
        if (props1 !== true && props2 !== undefined) {
          if (props2 === true) {
            props1 = true;
          } else {
            props1 = props1 || {};
            Object.assign(props1, props2);
          }
        }
      }
    }
  }
  if (errors === _errs10) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing5;
      if (data.status === undefined && (missing5 = "status")) {
        const err17 = {
          instancePath,
          schemaPath: "#/oneOf/1/required",
          keyword: "required",
          params: { missingProperty: missing5 },
          message: "must have required property '" + missing5 + "'",
        };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      } else {
        if (props1 !== true) {
          props1 = props1 || {};
          props1.kind = true;
        }
        if (data.kind !== undefined) {
          if ("state" !== data.kind) {
            const err18 = {
              instancePath: instancePath + "/kind",
              schemaPath: "#/oneOf/1/properties/kind/const",
              keyword: "const",
              params: { allowedValue: "state" },
              message: "must be equal to constant",
            };
            if (vErrors === null) {
              vErrors = [err18];
            } else {
              vErrors.push(err18);
            }
            errors++;
          }
        }
      }
    }
  }
  var _valid0 = _errs10 === errors;
  if (_valid0 && valid0) {
    valid0 = false;
    passing0 = [passing0, 1];
  } else {
    if (_valid0) {
      valid0 = true;
      passing0 = 1;
      if (props0 !== true && props1 !== undefined) {
        if (props1 === true) {
          props0 = true;
        } else {
          props0 = props0 || {};
          Object.assign(props0, props1);
        }
      }
    }
  }
  if (!valid0) {
    const err19 = {
      instancePath,
      schemaPath: "#/oneOf",
      keyword: "oneOf",
      params: { passingSchemas: passing0 },
      message: "must match exactly one schema in oneOf",
    };
    if (vErrors === null) {
      vErrors = [err19];
    } else {
      vErrors.push(err19);
    }
    errors++;
    validate20.errors = vErrors;
    return false;
  } else {
    errors = _errs1;
    if (vErrors !== null) {
      if (_errs1) {
        vErrors.length = _errs1;
      } else {
        vErrors = null;
      }
    }
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing6;
      if (
        (data.schemaVersion === undefined && (missing6 = "schemaVersion")) ||
        (data.eventId === undefined && (missing6 = "eventId")) ||
        (data.jobId === undefined && (missing6 = "jobId")) ||
        (data.projectId === undefined && (missing6 = "projectId")) ||
        (data.jobType === undefined && (missing6 = "jobType")) ||
        (data.sequence === undefined && (missing6 = "sequence")) ||
        (data.attempt === undefined && (missing6 = "attempt")) ||
        (data.occurredAt === undefined && (missing6 = "occurredAt")) ||
        (data.kind === undefined && (missing6 = "kind"))
      ) {
        validate20.errors = [
          {
            instancePath,
            schemaPath: "#/required",
            keyword: "required",
            params: { missingProperty: missing6 },
            message: "must have required property '" + missing6 + "'",
          },
        ];
        return false;
      } else {
        const _errs29 = errors;
        for (const key0 in data) {
          if (!func1.call(schema31.properties, key0)) {
            validate20.errors = [
              {
                instancePath,
                schemaPath: "#/additionalProperties",
                keyword: "additionalProperties",
                params: { additionalProperty: key0 },
                message: "must NOT have additional properties",
              },
            ];
            return false;
            break;
          }
        }
        if (_errs29 === errors) {
          if (data.schemaVersion !== undefined) {
            const _errs30 = errors;
            if (1 !== data.schemaVersion) {
              validate20.errors = [
                {
                  instancePath: instancePath + "/schemaVersion",
                  schemaPath: "#/properties/schemaVersion/const",
                  keyword: "const",
                  params: { allowedValue: 1 },
                  message: "must be equal to constant",
                },
              ];
              return false;
            }
            var valid14 = _errs30 === errors;
          } else {
            var valid14 = true;
          }
          if (valid14) {
            if (data.eventId !== undefined) {
              let data8 = data.eventId;
              const _errs31 = errors;
              if (errors === _errs31) {
                if (typeof data8 === "string") {
                  if (!pattern4.test(data8)) {
                    validate20.errors = [
                      {
                        instancePath: instancePath + "/eventId",
                        schemaPath: "#/properties/eventId/pattern",
                        keyword: "pattern",
                        params: {
                          pattern:
                            "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]*$",
                        },
                        message:
                          'must match pattern "' +
                          "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]*$" +
                          '"',
                      },
                    ];
                    return false;
                  }
                } else {
                  validate20.errors = [
                    {
                      instancePath: instancePath + "/eventId",
                      schemaPath: "#/properties/eventId/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    },
                  ];
                  return false;
                }
              }
              var valid14 = _errs31 === errors;
            } else {
              var valid14 = true;
            }
            if (valid14) {
              if (data.jobId !== undefined) {
                let data9 = data.jobId;
                const _errs33 = errors;
                if (errors === _errs33) {
                  if (typeof data9 === "string") {
                    if (!pattern5.test(data9)) {
                      validate20.errors = [
                        {
                          instancePath: instancePath + "/jobId",
                          schemaPath: "#/properties/jobId/pattern",
                          keyword: "pattern",
                          params: {
                            pattern:
                              "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                          },
                          message:
                            'must match pattern "' +
                            "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" +
                            '"',
                        },
                      ];
                      return false;
                    }
                  } else {
                    validate20.errors = [
                      {
                        instancePath: instancePath + "/jobId",
                        schemaPath: "#/properties/jobId/type",
                        keyword: "type",
                        params: { type: "string" },
                        message: "must be string",
                      },
                    ];
                    return false;
                  }
                }
                var valid14 = _errs33 === errors;
              } else {
                var valid14 = true;
              }
              if (valid14) {
                if (data.projectId !== undefined) {
                  let data10 = data.projectId;
                  const _errs35 = errors;
                  if (errors === _errs35) {
                    if (typeof data10 === "string") {
                      if (!pattern5.test(data10)) {
                        validate20.errors = [
                          {
                            instancePath: instancePath + "/projectId",
                            schemaPath: "#/properties/projectId/pattern",
                            keyword: "pattern",
                            params: {
                              pattern:
                                "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                            },
                            message:
                              'must match pattern "' +
                              "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" +
                              '"',
                          },
                        ];
                        return false;
                      }
                    } else {
                      validate20.errors = [
                        {
                          instancePath: instancePath + "/projectId",
                          schemaPath: "#/properties/projectId/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        },
                      ];
                      return false;
                    }
                  }
                  var valid14 = _errs35 === errors;
                } else {
                  var valid14 = true;
                }
                if (valid14) {
                  if (data.jobType !== undefined) {
                    let data11 = data.jobType;
                    const _errs37 = errors;
                    if (errors === _errs37) {
                      if (typeof data11 === "string") {
                        if (!pattern7.test(data11)) {
                          validate20.errors = [
                            {
                              instancePath: instancePath + "/jobType",
                              schemaPath: "#/properties/jobType/pattern",
                              keyword: "pattern",
                              params: { pattern: "^[a-z][a-z0-9.-]{0,63}$" },
                              message: 'must match pattern "' + "^[a-z][a-z0-9.-]{0,63}$" + '"',
                            },
                          ];
                          return false;
                        }
                      } else {
                        validate20.errors = [
                          {
                            instancePath: instancePath + "/jobType",
                            schemaPath: "#/properties/jobType/type",
                            keyword: "type",
                            params: { type: "string" },
                            message: "must be string",
                          },
                        ];
                        return false;
                      }
                    }
                    var valid14 = _errs37 === errors;
                  } else {
                    var valid14 = true;
                  }
                  if (valid14) {
                    if (data.sequence !== undefined) {
                      let data12 = data.sequence;
                      const _errs39 = errors;
                      if (!(typeof data12 == "number" && !(data12 % 1) && !isNaN(data12))) {
                        validate20.errors = [
                          {
                            instancePath: instancePath + "/sequence",
                            schemaPath: "#/properties/sequence/type",
                            keyword: "type",
                            params: { type: "integer" },
                            message: "must be integer",
                          },
                        ];
                        return false;
                      }
                      if (errors === _errs39) {
                        if (typeof data12 == "number") {
                          if (data12 > 9007199254740991 || isNaN(data12)) {
                            validate20.errors = [
                              {
                                instancePath: instancePath + "/sequence",
                                schemaPath: "#/properties/sequence/maximum",
                                keyword: "maximum",
                                params: { comparison: "<=", limit: 9007199254740991 },
                                message: "must be <= 9007199254740991",
                              },
                            ];
                            return false;
                          } else {
                            if (data12 < 1 || isNaN(data12)) {
                              validate20.errors = [
                                {
                                  instancePath: instancePath + "/sequence",
                                  schemaPath: "#/properties/sequence/minimum",
                                  keyword: "minimum",
                                  params: { comparison: ">=", limit: 1 },
                                  message: "must be >= 1",
                                },
                              ];
                              return false;
                            }
                          }
                        }
                      }
                      var valid14 = _errs39 === errors;
                    } else {
                      var valid14 = true;
                    }
                    if (valid14) {
                      if (data.attempt !== undefined) {
                        let data13 = data.attempt;
                        const _errs41 = errors;
                        if (!(typeof data13 == "number" && !(data13 % 1) && !isNaN(data13))) {
                          validate20.errors = [
                            {
                              instancePath: instancePath + "/attempt",
                              schemaPath: "#/properties/attempt/type",
                              keyword: "type",
                              params: { type: "integer" },
                              message: "must be integer",
                            },
                          ];
                          return false;
                        }
                        if (errors === _errs41) {
                          if (typeof data13 == "number") {
                            if (data13 < 0 || isNaN(data13)) {
                              validate20.errors = [
                                {
                                  instancePath: instancePath + "/attempt",
                                  schemaPath: "#/properties/attempt/minimum",
                                  keyword: "minimum",
                                  params: { comparison: ">=", limit: 0 },
                                  message: "must be >= 0",
                                },
                              ];
                              return false;
                            }
                          }
                        }
                        var valid14 = _errs41 === errors;
                      } else {
                        var valid14 = true;
                      }
                      if (valid14) {
                        if (data.occurredAt !== undefined) {
                          let data14 = data.occurredAt;
                          const _errs43 = errors;
                          if (errors === _errs43) {
                            if (typeof data14 === "string") {
                              if (!pattern8.test(data14)) {
                                validate20.errors = [
                                  {
                                    instancePath: instancePath + "/occurredAt",
                                    schemaPath: "#/properties/occurredAt/pattern",
                                    keyword: "pattern",
                                    params: {
                                      pattern:
                                        "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
                                    },
                                    message:
                                      'must match pattern "' +
                                      "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" +
                                      '"',
                                  },
                                ];
                                return false;
                              }
                            } else {
                              validate20.errors = [
                                {
                                  instancePath: instancePath + "/occurredAt",
                                  schemaPath: "#/properties/occurredAt/type",
                                  keyword: "type",
                                  params: { type: "string" },
                                  message: "must be string",
                                },
                              ];
                              return false;
                            }
                          }
                          var valid14 = _errs43 === errors;
                        } else {
                          var valid14 = true;
                        }
                        if (valid14) {
                          if (data.correlationId !== undefined) {
                            let data15 = data.correlationId;
                            const _errs45 = errors;
                            if (errors === _errs45) {
                              if (typeof data15 === "string") {
                                if (!pattern9.test(data15)) {
                                  validate20.errors = [
                                    {
                                      instancePath: instancePath + "/correlationId",
                                      schemaPath: "#/properties/correlationId/pattern",
                                      keyword: "pattern",
                                      params: { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
                                      message:
                                        'must match pattern "' +
                                        "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" +
                                        '"',
                                    },
                                  ];
                                  return false;
                                }
                              } else {
                                validate20.errors = [
                                  {
                                    instancePath: instancePath + "/correlationId",
                                    schemaPath: "#/properties/correlationId/type",
                                    keyword: "type",
                                    params: { type: "string" },
                                    message: "must be string",
                                  },
                                ];
                                return false;
                              }
                            }
                            var valid14 = _errs45 === errors;
                          } else {
                            var valid14 = true;
                          }
                          if (valid14) {
                            if (data.kind !== undefined) {
                              let data16 = data.kind;
                              const _errs47 = errors;
                              if (!(data16 === "state" || data16 === "progress")) {
                                validate20.errors = [
                                  {
                                    instancePath: instancePath + "/kind",
                                    schemaPath: "#/properties/kind/enum",
                                    keyword: "enum",
                                    params: { allowedValues: schema31.properties.kind.enum },
                                    message: "must be equal to one of the allowed values",
                                  },
                                ];
                                return false;
                              }
                              var valid14 = _errs47 === errors;
                            } else {
                              var valid14 = true;
                            }
                            if (valid14) {
                              if (data.percentage !== undefined) {
                                let data17 = data.percentage;
                                const _errs48 = errors;
                                if (errors === _errs48) {
                                  if (typeof data17 == "number") {
                                    if (data17 > 100 || isNaN(data17)) {
                                      validate20.errors = [
                                        {
                                          instancePath: instancePath + "/percentage",
                                          schemaPath: "#/properties/percentage/maximum",
                                          keyword: "maximum",
                                          params: { comparison: "<=", limit: 100 },
                                          message: "must be <= 100",
                                        },
                                      ];
                                      return false;
                                    } else {
                                      if (data17 < 0 || isNaN(data17)) {
                                        validate20.errors = [
                                          {
                                            instancePath: instancePath + "/percentage",
                                            schemaPath: "#/properties/percentage/minimum",
                                            keyword: "minimum",
                                            params: { comparison: ">=", limit: 0 },
                                            message: "must be >= 0",
                                          },
                                        ];
                                        return false;
                                      }
                                    }
                                  } else {
                                    validate20.errors = [
                                      {
                                        instancePath: instancePath + "/percentage",
                                        schemaPath: "#/properties/percentage/type",
                                        keyword: "type",
                                        params: { type: "number" },
                                        message: "must be number",
                                      },
                                    ];
                                    return false;
                                  }
                                }
                                var valid14 = _errs48 === errors;
                              } else {
                                var valid14 = true;
                              }
                              if (valid14) {
                                if (data.stage !== undefined) {
                                  let data18 = data.stage;
                                  const _errs50 = errors;
                                  if (!(
                                    data18 === "staging" ||
                                    data18 === "validating" ||
                                    data18 === "probing" ||
                                    data18 === "decoding" ||
                                    data18 === "proxy" ||
                                    data18 === "asr" ||
                                    data18 === "mix" ||
                                    data18 === "poster" ||
                                    data18 === "sprite" ||
                                    data18 === "uploading" ||
                                    data18 === "finalizing"
                                  )) {
                                    validate20.errors = [
                                      {
                                        instancePath: instancePath + "/stage",
                                        schemaPath: "#/properties/stage/enum",
                                        keyword: "enum",
                                        params: { allowedValues: schema31.properties.stage.enum },
                                        message: "must be equal to one of the allowed values",
                                      },
                                    ];
                                    return false;
                                  }
                                  var valid14 = _errs50 === errors;
                                } else {
                                  var valid14 = true;
                                }
                                if (valid14) {
                                  if (data.status !== undefined) {
                                    let data19 = data.status;
                                    const _errs51 = errors;
                                    if (!(
                                      data19 === "Queued" ||
                                      data19 === "Running" ||
                                      data19 === "Retrying" ||
                                      data19 === "Completed" ||
                                      data19 === "Failed" ||
                                      data19 === "Cancelled"
                                    )) {
                                      validate20.errors = [
                                        {
                                          instancePath: instancePath + "/status",
                                          schemaPath: "#/properties/status/enum",
                                          keyword: "enum",
                                          params: {
                                            allowedValues: schema31.properties.status.enum,
                                          },
                                          message: "must be equal to one of the allowed values",
                                        },
                                      ];
                                      return false;
                                    }
                                    var valid14 = _errs51 === errors;
                                  } else {
                                    var valid14 = true;
                                  }
                                  if (valid14) {
                                    if (data.reason !== undefined) {
                                      let data20 = data.reason;
                                      const _errs52 = errors;
                                      if (!(
                                        data20 === "processing_failed" || data20 === "cancelled"
                                      )) {
                                        validate20.errors = [
                                          {
                                            instancePath: instancePath + "/reason",
                                            schemaPath: "#/properties/reason/enum",
                                            keyword: "enum",
                                            params: {
                                              allowedValues: schema31.properties.reason.enum,
                                            },
                                            message: "must be equal to one of the allowed values",
                                          },
                                        ];
                                        return false;
                                      }
                                      var valid14 = _errs52 === errors;
                                    } else {
                                      var valid14 = true;
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate20.errors = [
        {
          instancePath,
          schemaPath: "#/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        },
      ];
      return false;
    }
  }
  validate20.errors = vErrors;
  return errors === 0;
}
validate20.evaluated = { props: true, dynamicProps: false, dynamicItems: false };
