odoo.define('web.KanbanRenderer', function (require) {
"use strict";

var AbstractRenderer = require('web.AbstractRenderer');
var core = require('web.core');
var KanbanColumn = require('web.KanbanColumn');
var KanbanRecord = require('web.KanbanRecord');
var quick_create = require('web.kanban_quick_create');
var kanban_widgets = require('web.kanban_widgets');
var QWeb = require('web.QWeb');
var session = require('web.session');
var utils = require('web.utils');

var ColumnQuickCreate = quick_create.ColumnQuickCreate;
var fields_registry = kanban_widgets.registry;

var qweb = core.qweb;

function find_in_node(node, predicate) {
    if (predicate(node)) {
        return node;
    }
    if (!node.children) {
        return undefined;
    }
    for (var i = 0; i < node.children.length; i++) {
        if (find_in_node(node.children[i], predicate)) {
            return node.children[i];
        }
    }
}

function qweb_add_if(node, condition) {
    if (node.attrs[qweb.prefix + '-if']) {
        condition = _.str.sprintf("(%s) and (%s)", node.attrs[qweb.prefix + '-if'], condition);
    }
    node.attrs[qweb.prefix + '-if'] = condition;
}

function transform_qweb_template(node, fields) {
    // Process modifiers
    if (node.tag && node.attrs.modifiers) {
        var modifiers = JSON.parse(node.attrs.modifiers || "{}");
        if (modifiers.invisible) {
            qweb_add_if(node, _.str.sprintf("!kanban_compute_domain(%s)", JSON.stringify(modifiers.invisible)));
        }
    }
    switch (node.tag) {
        case 'field':
            var ftype = fields[node.attrs.name].type;
            ftype = node.attrs.widget ? node.attrs.widget : ftype;
            if (ftype === 'many2many') {
                node.tag = 'div';
                node.attrs['class'] = (node.attrs['class'] || '') + ' oe_form_field o_form_field_many2manytags o_kanban_tags';
            } else if (fields_registry.contains(ftype)) {
                // do nothing, the kanban record will handle it
            } else {
                node.tag = qweb.prefix;
                node.attrs[qweb.prefix + '-esc'] = 'record.' + node.attrs.name + '.value';
            }
            break;
        case 'button':
        case 'a':
            var type = node.attrs.type || '';
            if (_.indexOf('action,object,edit,open,delete,url,set_cover'.split(','), type) !== -1) {
                _.each(node.attrs, function(v, k) {
                    if (_.indexOf('icon,type,name,args,string,context,states,kanban_states'.split(','), k) !== -1) {
                        node.attrs['data-' + k] = v;
                        delete(node.attrs[k]);
                    }
                });
                if (node.attrs['data-string']) {
                    node.attrs.title = node.attrs['data-string'];
                }
                if (node.tag === 'a' && node.attrs['data-type'] !== "url") {
                    node.attrs.href = '#';
                } else {
                    node.attrs.type = 'button';
                }
                node.attrs['class'] = (node.attrs['class'] || '') + ' oe_kanban_action oe_kanban_action_' + node.tag;
            }
            break;
    }
    if (node.children) {
        for (var i = 0, ii = node.children.length; i < ii; i++) {
            transform_qweb_template(node.children[i], fields);
        }
    }
}

return AbstractRenderer.extend({
    className: "o_kanban_view",
    init: function (parent, arch, fields, data, widgets_registry, record_options, column_options) {
        this._super.apply(this, arguments);

        this.qweb = new QWeb(session.debug, {_s: session.origin});
        var templates = find_in_node(arch, function(n) { return n.tag === 'templates';});
        transform_qweb_template(templates, fields);
        this.qweb.add_template(utils.json_node_to_xml(templates));

        this.record_options = _.extend({}, record_options, { qweb: this.qweb });
        this.column_options = _.extend({}, column_options, { qweb: this.qweb });
    },
    update: function (state, fields) {
        this.fields = fields;
        return this._super(state);
    },
    update_column: function (column, data, record_options) {
        record_options = _.extend({}, record_options, { qweb: this.qweb });
        var new_column = new KanbanColumn(this, data, this.column_options, record_options);
        return new_column.insertAfter(column.$el).then(column.destroy.bind(column));
    },
    _render: function () {
        var is_grouped = !!this.state.grouped_by.length;
        this.$el.toggleClass('o_kanban_grouped', is_grouped);
        this.$el.toggleClass('o_kanban_ungrouped', !is_grouped);
        this.$el.empty();

        var fragment = document.createDocumentFragment();
        if (is_grouped) {
            this._render_grouped(fragment);
        } else {
            this._render_ungrouped(fragment);
        }
        this.$el.append(fragment);
        return this._super.apply(this, arguments);
    },
    _render_ungrouped: function (fragment) {
        var self = this;
        _.each(this.state.data, function (record) {
            var kanban_record = new KanbanRecord(self, record, self.record_options);
            self.widgets.push(kanban_record);
            kanban_record.appendTo(fragment);
        });

        // add empty invisible divs to make sure that all kanban records are left aligned
        for (var i = 0, ghost_div; i < 6; i++) {
            ghost_div = $("<div>").addClass("o_kanban_record o_kanban_ghost");
            ghost_div.appendTo(fragment);
        }
    },
    _render_grouped: function (fragment) {
        var self = this;
        var group_by_field_attrs = this.fields[this.state.grouped_by[0]];
        // Deactivate the drag'n'drop if the grouped_by field:
        // - is a date or datetime since we group by month or
        // - is readonly
        var draggable = true;
        if (group_by_field_attrs) {
            if (group_by_field_attrs.type === "date" || group_by_field_attrs.type === "datetime") {
                draggable = false;
            } else if (group_by_field_attrs.readonly !== undefined) {
                draggable = !(group_by_field_attrs.readonly);
            }
        }
        var grouped_by_m2o = group_by_field_attrs && (group_by_field_attrs.type === 'many2one');
        var grouped_by_field = grouped_by_m2o && group_by_field_attrs.relation;
        this.column_options = _.extend(this.column_options, {
            draggable: draggable,
            grouped_by_m2o: grouped_by_m2o,
            relation: grouped_by_field,
        });

        // Render columns
        _.each(this.state.data, function (group) {
            var column = new KanbanColumn(self, group, self.column_options, self.record_options);
            if (!column.id) {
                column.prependTo(fragment); // display the 'Undefined' group first
                self.widgets.unshift(column);
            } else {
                column.appendTo(fragment);
                self.widgets.push(column);
            }
        });

        // Enable column sorting
        this.$el.sortable({
            axis: 'x',
            items: '> .o_kanban_group',
            handle: '.o_kanban_header',
            cursor: 'move',
            revert: 150,
            delay: 100,
            tolerance: 'pointer',
            forcePlaceholderSize: true,
            stop: function () {
                var ids = [];
                self.$('.o_kanban_group').each(function (index, u) {
                    ids.push($(u).data('id'));
                });
                self.trigger_up('resequence_columns', {ids: ids});
            },
        });

        // Column quick create
        if (this.column_options.group_creatable && grouped_by_m2o) {
            this.column_quick_create = new ColumnQuickCreate(this);
            this.column_quick_create.appendTo(fragment);
        }
    },
    add_quick_create: function () {
        this.widgets[0].add_quick_create();
    },
    remove_widget: function (widget) {
        this.widgets.splice(this.widgets.indexOf(widget), 1);
        widget.destroy();
    }
});

});
