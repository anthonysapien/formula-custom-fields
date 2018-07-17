var asana = require("asana");
var parseArgs = require("minimist");
var Bluebird = require('bluebird');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').load();
}

var argv = parseArgs(process.argv.slice(2));
var pat = process.env.PAT;
var projects = process.env.PROJECTS.split(",");
var client = asana.Client.create({
  // asanaBaseUrl: "https://localhost.asana.com:8180/"
}).useAccessToken(pat);

// process.on("unhandledRejection", function(reason, promise) {
  // console.log("Unhandled Rejection at: Promise ", promise, " reason: ", reason);
  // console.log(reason.stack);
  // throw Error("Global promise rejection handler");
// });

/**
 * Creates a "calc" function to evaluate formulas in this task.
 * @param task
 * @returns {calc formula_object => value} Evaluates the given formula in the context of this task
 */
var createCalcForTask = function(task) {
  var task_field_values_by_name = {};
  task.custom_fields.forEach(function(custom_field) {
    task_field_values_by_name[custom_field.name] = custom_field;
  });

  var calc = function(formula_object) {
    switch (typeof formula_object) {
      case "object":
        console.assert(Array.isArray(formula_object), "Invalid formula field", formula_object);

        // Recursive case, this is another formula
        var xs = formula_object;
        switch (xs.length) {
          case 2:
            switch (xs[0]) {
              case "!":
                return !calc(xs[1]);
              case "-":
                return -calc(xs[1]);
              default:
                throw new Error("Couldn't parse expression with 2 tokens");
            }
          case 3:
            switch (xs[1]) {
              case "+":
                return calc(xs[0]) + calc(xs[2]);
              case "-":
                return calc(xs[0]) - calc(xs[2]);
              case "*":
                return calc(xs[0]) * calc(xs[2]);
              case "/":
                return calc(xs[0]) / calc(xs[2]);
              case "=":
              case "==":
              case "===":
                return calc(xs[0]) === calc(xs[2]);
              case "!=":
              case "!==":
              case "<>": //Yeah basic!
                return calc(xs[0]) !== calc(xs[2]);
              case ">":
                return calc(xs[0]) > calc(xs[2]);
              case ">=":
                return calc(xs[0]) >= calc(xs[2]);
              case "<":
                return calc(xs[0]) < calc(xs[2]);
              case "<=":
                return calc(xs[0]) <= calc(xs[2]);
              case "&&":
                return calc(xs[0]) && calc(xs[2]);
              case "||":
                return calc(xs[0]) || calc(xs[2]);
              default:
                throw new Error("Couldn't parse expression with 3 tokens");
            }
          case 5:
            if (xs[1] === "?" && xs[3] === ":") {
              // Ternary if operator. We use javascript's truthiness
              return calc(xs[0]) ? calc(xs[2]) : calc(xs[4]);
            } else {
              throw new Error("Couldn't parse expression with 5 tokens");
            }
          default:
            throw new Error("Couldn't parse expression, unused number of tokens");
        }

      case "string":
        // A reference to another custom field, hopefully
        var field_value = task_field_values_by_name[formula_object];
        if ((field_value === null) || (field_value === undefined)) {
          // Referenced a field that this task doesn't have, use NaN to not write any value
          return NaN;
        } else if (field_value.number_value !== undefined) {
          if (field_value.number_value === null) {
            // This field is blank for this task, use NaN to not write any value
            return NaN;
          } else {
            return field_value.number_value;
          }
        } else if (field_value.text) {
          // Assume everything is a date and return the number of days
          return Date.parse(field_value.text) / Date.MILLISECONDS_PER_DAY;
        } else {
          throw new Error("Unexpected type of custom property", field_value);
        }

      case "number":
        // A literal
        return formula_object;

      default:
    }
  };

  return calc;
};

var updateFieldsOnTask = function(task, formula_fields) {
  var task_field_values_by_id = {};
  task.custom_fields.forEach(function(custom_field) {
    task_field_values_by_id[custom_field.id] = custom_field;
  });

  var calc = createCalcForTask(task);

  var new_custom_field_values_to_write_to_task = {};
  var any_new_custom_field_values_to_write = false;
  formula_fields.forEach(function(field) {
    // console.log("Field", field);
    var formula_json = field.description.substring(1);
    var formula_object = JSON.parse(formula_json);
    var formula_value = calc(formula_object);
    formula_value = formula_value.toFixed(field.precision);
    // console.log("Formula value", task.name, field.name, formula_value);
    if (!isNaN(formula_value)) {
      // TODO defend against formula fields not being numbers
      var existing_value = task_field_values_by_id[field.id].number_value;
      // console.log("existing value", existing_value, "formula value", formula_value);
      if (existing_value != formula_value) {
        new_custom_field_values_to_write_to_task[field.id] = formula_value;
        any_new_custom_field_values_to_write = true;
      }
    }
  });

  if (any_new_custom_field_values_to_write) {
    console.log("Updating fields");
    return client.tasks.update(task.id, {
      custom_fields: new_custom_field_values_to_write_to_task
    });
  } else {
    return Bluebird.resolve();
  }
};

var formulaFieldsForProject = function(project_id) {
  return client.projects.findById(project_id, {
    // TODO name is only here for debugging
    opt_fields: "custom_field_settings.custom_field.name,custom_field_settings.custom_field.description,custom_field_settings.custom_field.precision"
  }).then(function(project) {
    return project.custom_field_settings.map(function(cfs) {
      return cfs.custom_field;
    }).filter(function(custom_field) {
      return custom_field.description.startsWith("=");
    })
  }).catch((err) => {
    console.log(err);
    throw new Error("Error loading formula fields for project");
  });
};


var monitorProjectFormulaFields = function(project_id) {
  var current_sync_token = "";

  /**
   * A asynchronous-recursive function that loops forever, checking whether the project has changed and
   * dealing with it.
   */
  var checkOnProjectRepeatedly = function() {
    try {
      // console.log("Checking project", project_id);
      client.events.get(project_id, current_sync_token).then(function(event) {
        // console.log("Received events for project", project_id)
        current_sync_token = event.sync;

        if (event.errors && event.errors.length > 0) {
          // Refresh this project from scratch
          console.log("Refreshing project from scratch", project_id);
          formulaFieldsForProject(project_id).then(function(formula_fields) {
            // console.log("Requesting tasks for project", project_id);
            return client.tasks.findByProject(project_id, {
              opt_fields: "name,completed,custom_fields"
            }).then(function(tasks_collection) {
              // console.log("Received tasks for project", project_id);
              // We want to wait for all the tasks to be processed before resolving, but they
              // are streamed to us. The first promise waits for the array of individual task
              // promises to be completely full, then we wait for them all.
              var task_promises = [];
              return new Bluebird(function(streamDone) {
                tasks_collection.stream().on("data", function(task) {
                  task_promises.push(updateFieldsOnTask(task, formula_fields));
                }).on("end", streamDone);
              }).then(function() {
                return Bluebird.all(task_promises);
              });
            });
          }).catch((err) => {
            console.log(err);
            throw new Error("Error ")
          }).then(function() {
            console.log("Finished processing project", project_id);
            // Check again immediately, why not!
            checkOnProjectRepeatedly();
          }).catch((err) => {
            console.log(err);
            throw new Error("Error processing project");
          });
        } else {
          // console.log("Got incremental update from project", project_id, event);
          if (!event.data) {
            console.log("event", event);
          }
          if (event.data.length === 0) {
            // No updates, check again in a while
            Bluebird.delay(1000).then(checkOnProjectRepeatedly).catch((err) => {
              throw new Error("Error checking project");
            });
          } else {
            console.log("Change detected in project", project_id);
            console.log("Event data", event.data);
            var deletedTaskIds = new Set();
            var changedTaskIds = new Set();

            // Filter to only tasks and not heading tasks
            event.data = event.data.filter(function(entry) {
              return entry.type == "task" && !entry.resource.name.endsWith(":");
            });

            event.data.forEach(function(entry) {
              if (entry.action == "deleted") { deletedTaskIds.add(entry.resource.id); }
              if (entry.action == "changed") { changedTaskIds.add(entry.resource.id); }
            });

            var changedNotDeletedTaskIds = [...changedTaskIds].filter(id => !deletedTaskIds.has(id));

            // This is kinda similar to the full-refresh version above, but has much simpler concurrency,
            // but requires a separate request to load each task, so is worth keeping separate
            formulaFieldsForProject(project_id).then(function(formula_fields) {
              return Bluebird.all(changedNotDeletedTaskIds.map(function(task_id) {
                // console.log("Recalculating formulae on task", task_id);
                try {
                  return client.tasks.findById(task_id).then(function(task) {
                    console.log("Recalculating formulas for task", task_id, task.name);
                    // console.log("Task", task);
                    return updateFieldsOnTask(task, formula_fields);
                  });
                } catch(exception) {
                  console.log(exception);
                  return Bluebird.resolve();
                }
              }))
            }).then(function() {
              console.log("Finished processing project", project_id);
              // Check again immediately, why not!
              checkOnProjectRepeatedly();
            });
          }
        }
      }).catch((err) => {
        console.log(err);
        console.log("Error getting events for project. Checking again in 10s");
        // throw new Error("Error getting events for project");
        Bluebird.delay(10000).then(checkOnProjectRepeatedly);
      });
    } catch (exception) {
      console.log("*** Caught Exception ***");
      console.log(exception);
    }
  };

  checkOnProjectRepeatedly();
};

// Initial search for tasks to monitor, and update them all
projects.forEach(function(project_id) {
  // The monitoring for each project is started without waiting for any others,
  // so they act like separate threads
  monitorProjectFormulaFields(project_id);
});
