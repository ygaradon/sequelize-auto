var Sequelize = require('sequelize')
  , async = require('async')
  , fs = require('fs');

module.exports = (function(){
  var AutoSequelize = function(database, username, password, options) {
    this.sequelize = new Sequelize(database, username, password, options || {});
    this.queryInterface = this.sequelize.getQueryInterface();
    this.options = {};
  }

  AutoSequelize.prototype.run = function(options, callback) {
    var self = this;

    if (typeof options === "function") {
      callback = options;
      options = {};
    }

    options.global = options.global || 'Sequelize';
    options.local = options.local || 'sequelize';
    options.spaces = options.spaces || false;
    options.indentation = options.indentation || 1;
    options.directory = options.directory || './models';

    self.options = options;

    this.sequelize.query(this.queryInterface.QueryGenerator.showTablesQuery(), null, {raw: true})
    .error(function(err){
      console.log('ERR: ' + err);
    })
    .success(function(tables){
      var _tables = {}
        , _references = {};
      async.each(tables, function(table, _callback){
        var tableName = Array.isArray(table) ? table[0] : table;
        async.parallel([
          function(_callback){
            self.queryInterface.describeTable(tableName)
            .success(function(fields){
              _tables[tableName] = fields;
              _callback(null);
            });
          },
          function(_callback){
            self.queryInterface.showReferences(tableName)
            .success(function(references){
              _references[tableName] = references;
              _callback(null);
            }).error(function(){
              // in case this db does not support references
              _references[tableName] = [];
              _callback(null);
            });
          }
        ], function() {
          _callback(null);
        });

      }, function(){
        var spaces = ''
          , tableNames = Object.keys(_tables)
          , text = {}
          , imports = {}
          , relations = {};

        for (var x = 0; x < options.indentation; ++x) {
          spaces += (options.spaces === true ? ' ' : "\t");
        }

        async.each(tableNames, function(table, _callback){
          var fields = Object.keys(_tables[table])
            , references = _references[table];

          text[table] = "/* jshint indent: " + options.indentation + " */\n\n";
          text[table] += "module.exports = function(sequelize, DataTypes) {\n";
          text[table] += spaces + "return sequelize.define('" + table + "', { \n";

          fields.forEach(function(field, i){
            text[table] += spaces + spaces + field + ": {\n";
            var fieldAttr = Object.keys(_tables[table][field]);
            // Serial key for postgres...
            if (!!_tables[table][field].defaultValue && _tables[table][field].defaultValue.toLowerCase().indexOf('nextval') !== -1 && _tables[table][field].defaultValue.toLowerCase().indexOf('regclass') !== -1) {
              text[table] += spaces + spaces + spaces + "type: DataTypes.INTEGER,\n";
              text[table] += spaces + spaces + spaces + "primaryKey: true\n";
            } else {
              // ENUMs for postgres...
              if (_tables[table][field].type === "USER-DEFINED" && !!_tables[table][field].special) {
                _tables[table][field].type = "ENUM(" + _tables[table][field].special.map(function(f){ return "'" + f + "'"; }).join(',') + ")";
              }

              fieldAttr.forEach(function(attr, x){
                // We don't need the special attribute from postgresql describe table..
                if (attr === "special") {
                  return true;
                }
                else if ((attr === "defaultValue" && _tables[table][field][attr] === null) || attr === "allowNull"
                    || attr === "primaryKey" || attr === "autoIncrement") {
                  text[table] += spaces + spaces + spaces + attr + ": " + _tables[table][field][attr];
                }
                else if (attr === "type" && _tables[table][field][attr].indexOf('ENUM') === 0) {
                  text[table] += spaces + spaces + spaces + attr + ": DataTypes." + _tables[table][field][attr];
                } else {
                  var _attr = _tables[table][field][attr].toLowerCase()
                  , val = "'" + _tables[table][field][attr] + "'";

                  if (_attr === "tinyint(1)") {
                    val = 'DataTypes.BOOLEAN';
                  }
                  else if (_attr.match(/^(smallint|mediumint|tinyint|int)/)) {
                    var length = _attr.match(/\(\d+\)/);
                    val = 'DataTypes.INTEGER' + (!!length ? length : '');
                  }
                  else if (_attr.match(/^bigint/)) {
                    val = 'DataTypes.BIGINT';
                  }
                  else if (_attr.match(/^string|varchar|varying/)) {
                    val = 'DataTypes.STRING';
                  }
                  else if (_attr.match(/text$/)) {
                    val = 'DataTypes.TEXT';
                  }
                  else if (_attr.match(/^(date|time)/)) {
                    val = 'DataTypes.DATE';
                  }
                  else if (_attr.match(/^(float|decimal)/)) {
                    val = 'DataTypes.' + _attr.toUpperCase();
                  }

                  text[table] += spaces + spaces + spaces + attr + ": " + val;
                }

                if ((x+1) < fieldAttr.length && fieldAttr[x+1] !== "special") {
                  text[table] += ",";
                }
                text[table] += "\n";
              });
            }

            text[table] += spaces + spaces + "}";
            if ((i+1) < fields.length) {
              text[table] += ",";
            }
            text[table] += "\n";
          });

          text[table] += spaces + "}, {\n";
          if (!('updatedAt' in _tables[table] && 'createdAt' in _tables[table])) {
            text[table] += spaces + spaces + "timestamps: false,\n";
          }
          if (table.indexOf('_') !== -1) {
            text[table] += spaces + spaces + "underscored: true,\n";
          }
          text[table] += spaces + spaces + "tableName: '" + table + "'\n";
          text[table] += spaces + "});\n};\n";

          imports[table] = spaces + spaces + table + ": sequelize.import(__dirname + '/" + table + "'),\n";
          references.forEach(function(reference, i){
            var referenced_table_name = reference.referenced_table_name
              , column_name = reference.column_name;
            relations[table + i] = spaces + "self." + table + ".belongsTo(self." + referenced_table_name + ", { foreignKey: '" + column_name + "' });\n";
          });

          _callback(null);
        }, function(){
          var index = "index";
          text[index] = "/* jshint indent: " + options.indentation + " */\n\n";
          text[index] += "module.exports = function(sequelize, DataTypes) {\n";
          text[index] += spaces + "var self = { \n";
          text[index] += Object.keys(imports).map(function(i){return imports[i];}).join('');
          text[index] += spaces + "};\n";
          text[index] += Object.keys(relations).map(function(i){return relations[i];}).join('');
          text[index] += spaces + "return self;\n";
          text[index] += "};\n";

          self.write(text, callback);
        });
      });
    });
  }

  AutoSequelize.prototype.write = function(attributes, callback) {
    var tables = Object.keys(attributes)
      , self = this;

    async.series([
      function(_callback){
        fs.lstat(self.options.directory, function(err, stat){
          if (err || !stat.isDirectory()) {
            fs.mkdir(self.options.directory, _callback);
          } else {
            _callback(null);
          }
        })
      }
    ], function(err){
      if (err) return callback(err);

      async.each(tables, function(table, _callback){
        fs.writeFile(self.options.directory + '/' + table + '.js', attributes[table], function(err){
          if (err) return _callback(err);
          _callback(null);
        });
      }, function(err){
        callback(err, null);
      });
    });
  }

  return AutoSequelize;
})();
